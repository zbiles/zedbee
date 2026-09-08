import { compareCodeUnits } from "../../core/compare.js";
import { normalizeRepositoryRelativePath } from "../../attribution/fingerprint.js";
import type { CheckRunContext } from "../adapter.js";
import {
  ContainedFileSizeError,
  readContainedFile,
} from "../../inspection/read-json.js";
import {
  captureSnapshotRegistry,
  IGNORED_DIRECTORY_NAMES,
  type SnapshotRegistry,
} from "../../inspection/snapshot-registry.js";
import {
  capturedSourceRegistry,
  hasAnalysisSourceCapture,
} from "../../inspection/source-capture.js";

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

async function readTextSource(
  registry: SnapshotRegistry,
  repositoryPath: string,
  identityPath: string,
  required: boolean,
): Promise<SecretTextSource | undefined> {
  // A selected input is not permission to widen this consumer's inventory.
  const excluded = repositoryPath
    .split("/")
    .some((part) =>
      (IGNORED_DIRECTORY_NAMES as readonly string[]).includes(part),
    );
  const entry = excluded ? undefined : registry.resolve(repositoryPath);
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
    throw new SecretContentError({
      code: "SECRET_FILE_UNSAFE",
      message:
        "Secret analysis only scans regular files in the selected target.",
      path: repositoryPath,
      remediation:
        "Provide a regular file at this path or remove it from the selected target, then retry.",
    });
  }
  let content: string;
  try {
    content = await readContainedFile(registry, repositoryPath, {
      maxBytes: MAX_SECRET_FILE_BYTES,
    });
  } catch (error) {
    if (!(error instanceof ContainedFileSizeError)) throw error;
    throw new SecretContentError({
      code: "SECRET_FILE_TOO_LARGE",
      message: "A changed file exceeds the Secretlint file-size safety limit.",
      path: repositoryPath,
      remediation:
        "Reduce the selected target file below 1 MiB or disable the secrets check in Zedbee configuration, then retry.",
    });
  }
  if (Buffer.byteLength(content, "utf8") > MAX_SECRET_FILE_BYTES) {
    throw new SecretContentError({
      code: "SECRET_FILE_TOO_LARGE",
      message: "A changed file exceeds the Secretlint file-size safety limit.",
      path: repositoryPath,
      remediation:
        "Reduce the selected target file below 1 MiB or disable the secrets check in Zedbee configuration, then retry.",
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
  const liveRegistries = new Map<string, Promise<SnapshotRegistry>>();
  if (!hasAnalysisSourceCapture()) {
    const roots = [
      context.baselineInspection.snapshotRoot,
      context.targetInspection.snapshotRoot,
    ];
    const registries = await Promise.all(
      roots.map((root) => captureSnapshotRegistry(root)),
    );
    roots.forEach((root, index) =>
      liveRegistries.set(root, Promise.resolve(registries[index]!)),
    );
  }
  const readSelected = async (root: string, path: string, identity: string) => {
    let registry = capturedSourceRegistry(root, [path]);
    if (registry === undefined) {
      let pending = liveRegistries.get(root);
      if (pending === undefined) {
        pending = captureSnapshotRegistry(root);
        liveRegistries.set(root, pending);
      }
      registry = await pending;
    }
    return readTextSource(registry, path, identity, true);
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
          ),
      readSelected(
        context.targetInspection.snapshotRoot,
        targetPath,
        targetPath,
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
