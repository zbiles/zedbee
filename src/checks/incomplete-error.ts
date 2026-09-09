import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import { displayLabel, displayProse } from "../core/display-text.js";
import type { IncompleteDisposition } from "../core/types.js";
import {
  sanitizeAnalyzerDiagnostic,
  type AnalyzerDiagnostic,
} from "./diagnostics.js";

export interface CheckIncompleteErrorOptions {
  readonly diagnostic?: AnalyzerDiagnostic;
  readonly code: string;
  readonly message: string;
  readonly remediation: string;
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly snapshot?: "last-commit" | "staged";
  readonly projectPaths?: readonly string[];
  readonly disposition?: IncompleteDisposition;
}

/** A deliberately small, display-safe boundary for expected incomplete checks. */
export class CheckIncompleteError extends Error {
  readonly diagnostic?: AnalyzerDiagnostic;
  readonly code: string;
  readonly remediation: string;
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly snapshot?: "last-commit" | "staged";
  readonly projectPaths?: readonly string[];
  readonly disposition?: IncompleteDisposition;

  constructor(options: CheckIncompleteErrorOptions) {
    const message = displayProse(options.message, "incomplete error message", {
      allowEmpty: true,
    });
    super(message);
    this.name = "CheckIncompleteError";
    if (options.diagnostic !== undefined)
      this.diagnostic = sanitizeAnalyzerDiagnostic(options.diagnostic);
    this.code = displayLabel(options.code, "incomplete error code");
    this.remediation = displayProse(
      options.remediation,
      "incomplete error remediation",
      { allowEmpty: true },
    );
    if (options.path !== undefined) {
      this.path = normalizeRepositoryRelativePath(options.path);
    }
    if (options.paths !== undefined) {
      this.paths = Object.freeze(
        [...new Set(options.paths.map(normalizeRepositoryRelativePath))].sort(),
      );
    }
    if (
      options.snapshot !== undefined &&
      options.snapshot !== "last-commit" &&
      options.snapshot !== "staged"
    ) {
      throw new TypeError("Expected a valid snapshot label");
    }
    if (options.snapshot !== undefined) this.snapshot = options.snapshot;
    if (options.projectPaths !== undefined) {
      this.projectPaths = Object.freeze(
        [
          ...new Set(options.projectPaths.map(normalizeRepositoryRelativePath)),
        ].sort(),
      );
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
