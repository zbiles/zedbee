import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import { displayLabel, displayProse } from "../core/display-text.js";
import type { IncompleteDisposition } from "../core/types.js";

export interface CheckIncompleteErrorOptions {
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
  readonly path?: string;
  readonly disposition?: IncompleteDisposition;
}

/** A deliberately small, display-safe boundary for expected incomplete checks. */
export class CheckIncompleteError extends Error {
  readonly code: string;
  readonly remediation: string;
  readonly path?: string;
  readonly disposition?: IncompleteDisposition;

  constructor(options: CheckIncompleteErrorOptions) {
    const message = displayProse(options.message, "incomplete error message", {
      allowEmpty: true,
    });
    super(message);
    this.name = "CheckIncompleteError";
    this.code = displayLabel(options.code, "incomplete error code");
    this.remediation = displayProse(
      options.remediation,
      "incomplete error remediation",
      { allowEmpty: true },
    );
    if (options.path !== undefined) {
      this.path = normalizeRepositoryRelativePath(options.path);
    }
    if (
      options.disposition !== undefined &&
      options.disposition !== "block" &&
      options.disposition !== "warn"
    ) {
      throw new TypeError("Expected a valid incomplete disposition");
    }
    if (options.disposition !== undefined) {
      this.disposition = options.disposition;
    }
    Object.freeze(this);
  }
}
