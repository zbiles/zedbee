import type { CheckResult, IncompleteDisposition } from "../core/types.js";

export interface IncompleteResultInput {
  readonly diagnostic?: import("./diagnostics.js").AnalyzerDiagnostic;
  readonly checkId: string;
  readonly durationMs: number;
  readonly code: string;
  readonly message: string;
  readonly target?: string;
  readonly path?: string;
  readonly paths?: readonly string[];
  readonly snapshot?: "last-commit" | "staged";
  readonly projectPaths?: readonly string[];
  readonly remediation: string;
  readonly disposition?: IncompleteDisposition;
}

export function incompleteResult(input: IncompleteResultInput): CheckResult {
  return {
    checkId: input.checkId,
    ...(input.target === undefined ? {} : { target: input.target }),
    status: "incomplete",
    durationMs: input.durationMs,
    findings: [],
    ...(input.disposition === undefined
      ? {}
      : { incompleteDisposition: input.disposition }),
    error: {
      ...(input.diagnostic === undefined
        ? {}
        : { diagnostic: input.diagnostic }),
      code: input.code,
      message: input.message,
      ...(input.path === undefined ? {} : { path: input.path }),
      ...(input.paths === undefined ? {} : { paths: input.paths }),
      ...(input.snapshot === undefined ? {} : { snapshot: input.snapshot }),
      ...(input.projectPaths === undefined
        ? {}
        : { projectPaths: input.projectPaths }),
      remediation: input.remediation,
    },
  };
}
