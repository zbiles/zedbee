import { RepositoryInspectionError } from "../../inspection/types.js";
import { compareCodeUnits } from "../../core/compare.js";
import { normalizeRepositoryRelativePath } from "../../attribution/fingerprint.js";
import type { CheckRunContext } from "../adapter.js";
import type { UnsupportedIndexEntry } from "../../git/snapshot.js";
import {
  ContainedFileSizeError,
  readContainedFile,
} from "../../inspection/read-json.js";
import {
  captureSnapshotRegistry,
  IGNORED_DIRECTORY_NAMES,
  type SnapshotRegistry,
} from "../../inspection/snapshot-registry.js";
import { capturedSourceRegistry } from "../../inspection/source-capture.js";

export const MAX_SECRET_FILE_BYTES = 1024 * 1024;

export type SecretContentErrorCode =
  "SECRET_FILE_INVALID_UTF8" | "SECRET_FILE_TOO_LARGE" | "SECRET_FILE_UNSAFE";

export class SecretContentError extends Error {
  readonly code: SecretContentErrorCode;
  readonly path: string;
  readonly remediation: string;

  constructor(options: {
    readonly code: SecretContentErrorCode;
    readonly message: string;
    readonly path: string;
    readonly remediation: string;
  }) {
    super(options.message);
    this.name = "SecretContentError";
    this.code = options.code;
    this.path = normalizeRepositoryRelativePath(options.path);
    this.remediation = options.remediation;
    Object.freeze(this);
  }
}

export interface SecretTextSource {
  readonly content: string;
  readonly reportPath: string;
  readonly identityPath: string;
}

export interface SecretSourcePair {
  readonly baseline?: SecretTextSource;
  readonly target?: SecretTextSource;
}

function unsafeSecretFile(path: string): SecretContentError {
  return new SecretContentError({
    code: "SECRET_FILE_UNSAFE",
    message: "Secret analysis only scans regular files in the selected target.",
    path,
    remediation:
      "Provide a regular file at this path or remove it from the selected target, then retry.",
  });
}

async function readTextSource(
  registry: SnapshotRegistry,
  repositoryPath: string,
  identityPath: string,
  required: boolean,
  binary: boolean,
): Promise<SecretTextSource | undefined> {
  // A selected input is not permission to widen this consumer's inventory.
  const excluded = repositoryPath
    .split("/")
    .some((part) =>
      (IGNORED_DIRECTORY_NAMES as readonly string[]).includes(part),
    );
  let entry;
  try {
    entry = excluded ? undefined : registry.resolve(repositoryPath);
  } catch {
    throw unsafeSecretFile(repositoryPath);
  }
  if (entry === undefined) {
    if (!required) return undefined;
    throw new SecretContentError({
      code: "SECRET_FILE_UNSAFE",
      message: "A changed file could not be read from the required snapshot.",
      path: repositoryPath,
      remediation:
        "Refresh the selected target snapshot and retry the scan. If it persists, run zedbee doctor.",
    });
  }
  if (entry.kind === "symlink" || entry.targetKind !== "file") {
    throw unsafeSecretFile(repositoryPath);
  }
  // Git classifies the complete blob while materializing each snapshot. Use
  // that result before the text size limit, including binary baselines and
  // files too large for the optional immutable source capture.
  if (binary) return undefined;
  let content: string;
  try {
    content = await readContainedFile(registry, repositoryPath, {
      maxBytes: MAX_SECRET_FILE_BYTES,
    });
  } catch (error) {
    if (!(error instanceof ContainedFileSizeError)) throw error;
    throw new SecretContentError({
      code: "SECRET_FILE_TOO_LARGE",
      message: "A changed text file exceeds the 1 MiB secrets-scanning limit.",
      path: repositoryPath,
      remediation:
        "Reduce this text file to at most 1 MiB, or intentionally exclude its path from the secrets check with pathExclusions, then retry.",
    });
  }
  if (Buffer.byteLength(content, "utf8") > MAX_SECRET_FILE_BYTES) {
    throw new SecretContentError({
      code: "SECRET_FILE_TOO_LARGE",
      message: "A changed text file exceeds the 1 MiB secrets-scanning limit.",
      path: repositoryPath,
      remediation:
        "Reduce this text file to at most 1 MiB, or intentionally exclude its path from the secrets check with pathExclusions, then retry.",
    });
  }
  if (content.includes("\u0000")) return undefined;
  if (content.includes("\ufffd")) {
    throw new SecretContentError({
      code: "SECRET_FILE_INVALID_UTF8",
      message:
        "A changed file is not valid UTF-8 and cannot be scanned safely.",
      path: repositoryPath,
      remediation:
        "Convert the selected target file to valid UTF-8 text and retry.",
    });
  }
  return Object.freeze({ content, reportPath: repositoryPath, identityPath });
}

export async function collectSecretSourcePairs(
  context: CheckRunContext,
): Promise<readonly SecretSourcePair[]> {
  const changed = [...context.changeSet.files.values()]
    .filter(({ status }) => status !== "deleted")
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const pairs: SecretSourcePair[] = [];
  const binaryPaths = (entries: readonly UnsupportedIndexEntry[]) =>
    new Set(
      entries
        .filter((entry) => entry.kind === "binary")
        .map(({ path }) => path),
    );
  const baselineBinaryPaths = binaryPaths(
    context.snapshots?.baselineUnsupportedEntries ?? [],
  );
  const targetBinaryPaths = binaryPaths(
    context.snapshots?.unsupportedEntries ?? [],
  );
  const liveRegistries = new Map<string, Promise<SnapshotRegistry>>();
  const requiredPaths = new Map<string, Set<string>>();
  for (const file of changed) {
    const add = (root: string, path: string) => {
      let paths = requiredPaths.get(root);
      if (paths === undefined) {
        paths = new Set();
        requiredPaths.set(root, paths);
      }
      paths.add(path);
    };
    add(context.targetInspection.snapshotRoot, file.path);
    if (file.status !== "added")
      add(
        context.baselineInspection.snapshotRoot,
        file.previousPath ?? file.path,
      );
  }
  const readSelected = async (
    root: string,
    path: string,
    identity: string,
    binary: boolean,
  ) => {
    let registry = capturedSourceRegistry(root, [path]);
    if (registry === undefined) {
      let pending = liveRegistries.get(root);
      if (pending === undefined) {
        const paths = [...(requiredPaths.get(root) ?? [])];
        pending = captureSnapshotRegistry(root, paths).catch(
          (error: unknown) => {
            const failed =
              error instanceof RepositoryInspectionError &&
              error.path !== undefined &&
              paths.includes(error.path)
                ? error.path
                : path;
            throw unsafeSecretFile(failed);
          },
        );
        liveRegistries.set(root, pending);
      }
      registry = await pending;
    }
    return readTextSource(registry, path, identity, true, binary);
  };
  for (const file of changed) {
    const targetPath = normalizeRepositoryRelativePath(file.path);
    const baselinePath =
      file.status === "added"
        ? undefined
        : normalizeRepositoryRelativePath(file.previousPath ?? file.path);
    const [baseline, target] = await Promise.all([
      baselinePath === undefined
        ? undefined
        : readSelected(
            context.baselineInspection.snapshotRoot,
            baselinePath,
            targetPath,
            baselineBinaryPaths.has(baselinePath),
          ),
      readSelected(
        context.targetInspection.snapshotRoot,
        targetPath,
        targetPath,
        targetBinaryPaths.has(targetPath),
      ),
    ]);
    if (baseline === undefined && target === undefined) continue;
    pairs.push(
      Object.freeze({
        ...(baseline === undefined ? {} : { baseline }),
        ...(target === undefined ? {} : { target }),
      }),
    );
  }
  return Object.freeze(pairs);
}
