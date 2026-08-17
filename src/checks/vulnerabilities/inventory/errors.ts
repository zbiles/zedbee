import { displayLabel, displayProse } from "../../../core/display-text.js";

export type LockfileInventoryErrorCode =
  | "LOCKFILE_INVALID"
  | "LOCKFILE_VERSION_UNSUPPORTED"
  | "LOCKFILE_VERSION_MISSING"
  | "LOCKFILE_VERSION_INVALID"
  | "LOCKFILE_LIMIT_EXCEEDED"
  | "LOCKFILE_NOT_DISCOVERED"
  | "LOCKFILE_UNSUPPORTED";

export class LockfileInventoryError extends Error {
  readonly code: LockfileInventoryErrorCode;

  constructor(code: LockfileInventoryErrorCode, message: string) {
    super(displayProse(message, "lockfile inventory error"));
    this.name = "LockfileInventoryError";
    this.code = displayLabel(code, "lockfile inventory error code") as LockfileInventoryErrorCode;
    Object.freeze(this);
  }
}

export function inventoryError(
  code: LockfileInventoryErrorCode,
  message: string,
): LockfileInventoryError {
  return new LockfileInventoryError(code, message);
}
