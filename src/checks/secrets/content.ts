import { compareCodeUnits } from "../../core/compare.js";
import { normalizeRepositoryRelativePath } from "../../attribution/fingerprint.js";
import type { CheckRunContext } from "../adapter.js";
import {
  ContainedFileSizeError,
  readContainedFile,
} from "../../inspection/read-json.js";
import {
  captureSnapshotRegistry,
  type SnapshotRegistry,
} from "../../inspection/snapshot-registry.js";

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
  const entry = registry.resolve(repositoryPath);
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
  const [baselineRegistry, targetRegistry] = await Promise.all([
    captureSnapshotRegistry(context.baselineInspection.snapshotRoot),
    captureSnapshotRegistry(context.targetInspection.snapshotRoot),
  ]);
  const changed = [...context.changeSet.files.values()]
    .filter(({ status }) => status !== "deleted")
    .sort((left, right) => compareCodeUnits(left.path, right.path));
  const pairs: SecretSourcePair[] = [];
  for (const file of changed) {
    const targetPath = normalizeRepositoryRelativePath(file.path);
    const baselinePath =
      file.status === "added"
        ? undefined
        : normalizeRepositoryRelativePath(file.previousPath ?? file.path);
    const [baseline, target] = await Promise.all([
      baselinePath === undefined
        ? undefined
        : readTextSource(baselineRegistry, baselinePath, targetPath, true),
      readTextSource(targetRegistry, targetPath, targetPath, true),
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
