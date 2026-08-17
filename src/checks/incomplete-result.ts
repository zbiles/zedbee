import type {
  CheckResult,
  IncompleteDisposition,
} from "../core/types.js";

export interface IncompleteResultInput {
  readonly checkId: string;
  readonly durationMs: number;
  readonly code: string;
  readonly message: string;
  readonly target?: string;
  readonly path?: string;
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
      code: input.code,
      message: input.message,
      ...(input.path === undefined ? {} : { path: input.path }),
      remediation: input.remediation,
    },
  };
}
