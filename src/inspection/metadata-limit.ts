import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import {
  ContainedFileSizeError,
  MAX_REPOSITORY_DATA_BYTES,
} from "./read-json.js";

/** Only render a fixed diagnostic and a validated repository-relative path. */
export function metadataSizeFailure(
  error: unknown,
):
  | {
      readonly path?: string;
      readonly message: string;
      readonly remediation: string;
    }
  | undefined {
  if (
    !(error instanceof ContainedFileSizeError) ||
    error.maxBytes !== MAX_REPOSITORY_DATA_BYTES
  )
    return undefined;
  let path: string | undefined;
  try {
    path = normalizeRepositoryRelativePath(error.path);
  } catch {
    // Even when a path is unreportable, the limit is actionable.
  }
  return {
    ...(path === undefined ? {} : { path }),
    message:
      "Repository metadata exceeds Zedbee's 16 MiB (16,777,216 byte) file limit.",
    remediation:
      "Reduce the reported metadata file to 16 MiB or less, stage the intended metadata, and retry.",
  };
}
