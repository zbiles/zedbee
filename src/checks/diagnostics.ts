import type { CheckId } from "../config/schema.js";
import { managedCheckMetadata } from "./metadata.js";
import { readInstalledPackageVersion } from "./engine-identity.js";

export const ANALYZER_OPERATIONS = [
  "collect",
  "runLegacy",
  "planFixes",
  "format-working-source",
] as const;
export type AnalyzerOperation = (typeof ANALYZER_OPERATIONS)[number];
export const ANALYZER_FAILURE_CATEGORIES = [
  "startup",
  "execution",
  "cancellation",
  "abnormal-exit",
  "invalid-response",
  "cleanup",
] as const;
export type AnalyzerFailureCategory =
  (typeof ANALYZER_FAILURE_CATEGORIES)[number];
const SIGNALS = new Set([
  "SIGTERM",
  "SIGKILL",
  "SIGINT",
  "SIGABRT",
  "SIGSEGV",
  "SIGBUS",
  "SIGILL",
  "SIGFPE",
  "SIGHUP",
  "SIGBREAK",
]);
const ENGINES: Readonly<Record<CheckId, string>> = Object.freeze({
  formatting: "prettier",
  lint: "eslint",
  types: "typescript",
  cyclomaticComplexity: "eslint",
  readabilityComplexity: "eslint",
  structuralSecurity: "@ast-grep/napi",
  secrets: "@secretlint/core",
  duplication: "jscpd",
  dependencyArchitecture: "dependency-cruiser",
  deadCode: "knip",
  reactCorrectness: "eslint",
  reactAccessibility: "eslint",
  vulnerabilities: "osv",
});
const VERSION = /^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u;

export interface AnalyzerDiagnostic {
  readonly checkId: CheckId;
  readonly operation: AnalyzerOperation;
  readonly category: AnalyzerFailureCategory;
  readonly snapshot?: "baseline" | "target";
  readonly engine: { readonly name: string; readonly version?: string };
  readonly exitCode?: number;
  readonly signal?: string;
}

/** Copy only known fields and values; never accept raw exception/stdio prose. */
export function sanitizeAnalyzerDiagnostic(
  value: AnalyzerDiagnostic,
): AnalyzerDiagnostic {
  if (
    !value ||
    !managedCheckMetadata(value.checkId) ||
    !ANALYZER_OPERATIONS.includes(value.operation) ||
    !ANALYZER_FAILURE_CATEGORIES.includes(value.category) ||
    value.engine?.name !== ENGINES[value.checkId] ||
    (value.engine.version !== undefined &&
      (!VERSION.test(value.engine.version) ||
        value.engine.version.length > 100)) ||
    (value.snapshot !== undefined &&
      value.snapshot !== "baseline" &&
      value.snapshot !== "target") ||
    (value.exitCode !== undefined &&
      (!Number.isSafeInteger(value.exitCode) ||
        value.exitCode < 0 ||
        value.exitCode > 0xffffffff)) ||
    (value.signal !== undefined && !SIGNALS.has(value.signal))
  )
    throw new TypeError("Invalid analyzer diagnostic");
  return Object.freeze({
    checkId: value.checkId,
    operation: value.operation,
    category: value.category,
    engine: Object.freeze({
      name: value.engine.name,
      ...(value.engine.version === undefined
        ? {}
        : { version: value.engine.version }),
    }),
    ...(value.snapshot === undefined ? {} : { snapshot: value.snapshot }),
    ...(value.exitCode === undefined ? {} : { exitCode: value.exitCode }),
    ...(value.signal === undefined ? {} : { signal: value.signal }),
  });
}

export function analyzerDiagnostic(
  checkId: CheckId,
  operation: AnalyzerOperation,
  category: AnalyzerFailureCategory,
  exitCode?: number | null,
  signal?: string | null,
): AnalyzerDiagnostic {
  const name = ENGINES[checkId];
  const version =
    name === "osv" ? undefined : readInstalledPackageVersion(name);
  return sanitizeAnalyzerDiagnostic({
    checkId,
    operation,
    category,
    engine: {
      name,
      ...(version !== undefined &&
      version.length <= 100 &&
      VERSION.test(version)
        ? { version }
        : {}),
    },
    ...(exitCode == null ? {} : { exitCode }),
    ...(signal == null || !SIGNALS.has(signal) ? {} : { signal }),
  });
}

export class AnalyzerJobError extends Error {
  readonly diagnostic: AnalyzerDiagnostic;
  constructor(diagnostic: AnalyzerDiagnostic) {
    super("The managed analyzer job could not complete.");
    this.name = "AnalyzerJobError";
    this.diagnostic = sanitizeAnalyzerDiagnostic(diagnostic);
  }
}
