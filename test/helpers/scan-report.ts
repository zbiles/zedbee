import type {
  CheckResult,
  Finding,
  Observation,
  RunSummary,
  SourceLocation,
} from "../../src/core/types.js";
import type { ScanReport } from "../../src/scan/report.js";
import { EMPTY_AGENT_GUIDANCE } from "../../src/reporting/agent-guidance.js";

export function createFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "finding-1",
    check: "formatting",
    rule: "prettier",
    severity: "error",
    message: "Staged code does not match the managed format.",
    location: { file: "src/value.ts", startLine: 2, endLine: 2 },
    remediation: "Format the staged lines, then stage the result.",
    attribution: {
      kind: "transformation-diff",
      staged: true,
      evidence: ["Prettier transformation overlaps staged target lines 2-2"],
    },
    ...overrides,
  };
}

export function createObservation(
  overrides: Omit<Partial<Observation>, "location"> & {
    readonly location?: SourceLocation | undefined;
  } = {},
): Observation {
  const base: Observation = {
    check: "lint",
    rule: "no-unsafe-call",
    identity: "diagnostic:no-unsafe-call",
    severity: "error",
    message: "Unsafe call from staged code",
    location: {
      file: "src/value.ts",
      startLine: 4,
      startColumn: 3,
      endLine: 4,
      endColumn: 12,
    },
    remediation: "Use a typed callable value.",
  };
  const merged = { ...base, ...overrides };
  if (
    Object.prototype.hasOwnProperty.call(overrides, "location") &&
    overrides.location === undefined
  ) {
    const { location: _location, ...withoutLocation } = merged;
    return withoutLocation as Observation;
  }
  return merged as Observation;
}

export function createReport(overrides: Partial<ScanReport> = {}): ScanReport {
  const checks: readonly CheckResult[] = overrides.checks ?? [
    {
      checkId: "formatting",
      status: "completed",
      durationMs: 4,
      findings: [],
    },
  ];
  const summary: RunSummary = overrides.summary ?? {
    passed: 1,
    warnings: 0,
    failed: 0,
    incomplete: 0,
    findings: [],
  };
  return {
    schemaVersion: 1,
    outcome: "pass",
    exitCode: 0,
    repositoryRoot: "/repo",
    baseline: "HEAD",
    target: "index",
    stagedFileCount: 1,
    startedAt: "2026-08-15T00:00:00.000Z",
    durationMs: 15,
    networkDisclosures: [],
    presentationPolicy: {
      terminalFindingLimit: 25,
      temporaryReportMaxAge: "24h",
      persistSourceExcerpts: false,
      agentGuidance: EMPTY_AGENT_GUIDANCE,
    },
    summary,
    checks,
    ...overrides,
  };
}
