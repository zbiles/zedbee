import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import type { Finding, CheckResult } from "../../src/core/types.js";
import {
  summarizeFindings,
  fitScanDetails,
} from "../../src/telemetry/finding-summary.js";
import {
  allowedFindingRule,
  findingLabel,
} from "../../src/telemetry/finding-rules.js";
import {
  scanDetailsSchema,
  telemetryEventSchema,
  telemetryV1EventSchema,
} from "../../src/telemetry/schema.js";

const context = {
  ai_detection_version: 1 as const,
  caller_ai_tool: "unknown" as const,
  caller_ai_tool_candidates: [],
  caller_ai_tool_source: "none" as const,
  detected_ai_tools: [],
  generic_agent_instructions_detected: false,
  repo_ai_detection_status: "complete" as const,
};
function finding(rule: string, check = "lint"): Finding {
  return {
    id: "private-fingerprint",
    rule,
    check,
    severity: "error",
    message: "PRIVATE SOURCE",
    location: { file: "/private/repo/file.ts" },
    attribution: { kind: "range-overlap", staged: true, evidence: [] },
  };
}
function check(checkId: string, status: CheckResult["status"]): CheckResult {
  return { checkId, status, durationMs: 1, findings: [] };
}
function report(findings: Finding[], checks: CheckResult[] = []) {
  return {
    summary: { passed: 0, failed: 0, warnings: 0, incomplete: 0, findings },
    checks,
  };
}
describe("safe finding summaries", () => {
  it("groups exact rules without serializing report content and excludes mixed incomplete targets", () => {
    const value = summarizeFindings(
      report(
        [
          finding("no-unused-vars"),
          finding("no-unused-vars"),
          finding("/private/rule"),
        ],
        [
          check("lint", "completed"),
          check("lint", "incomplete"),
          check("types", "completed"),
          check("secrets", "skipped"),
        ],
      ),
    );
    expect(value).toMatchObject({
      finding_groups: [
        {
          check_id: "lint",
          rule_id: "no-unused-vars",
          severity: "error",
          count: 2,
        },
      ],
      finding_unmapped_count: 1,
      finding_omitted_count: 0,
      finding_counts_clipped: false,
      finding_breakdown_status: "truncated",
      completed_check_ids: ["types"],
    });
    expect(JSON.stringify(value)).not.toMatch(/PRIVATE|private|fingerprint/);
  });
  it("represents a completed scan with no findings as a complete empty breakdown", () => {
    expect(summarizeFindings(report([]))).toMatchObject({
      finding_groups: [],
      finding_breakdown_status: "complete",
      finding_unmapped_count: 0,
    });
  });
  it("recognizes bundled rules and only canonical public advisory identifiers", () => {
    expect(
      allowedFindingRule("reactCorrectness", "react-hooks/exhaustive-deps"),
    ).toBe(true);
    expect(allowedFindingRule("lint", "react-hooks/exhaustive-deps")).toBe(
      false,
    );
    expect(allowedFindingRule("types", "typescript/TS2322")).toBe(true);
    expect(allowedFindingRule("types", "typescript/TS99999999")).toBe(false);
    expect(allowedFindingRule("vulnerabilities", "GHSA-2345-6789-cfgh")).toBe(
      true,
    );
    expect(
      allowedFindingRule("vulnerabilities", "private-package-advisory"),
    ).toBe(false);
    expect(
      findingLabel("structuralSecurity", "tls-verification-disabled"),
    ).toMatch(/TLS/i);
  });
  it("bounds large breakdowns and explicitly accounts for every omitted finding", () => {
    const groups = Array.from({ length: 300 }, (_, i) => ({
      check_id: "types" as const,
      rule_id: `typescript/TS${1000 + i}`,
      severity: "error" as const,
      count: 1,
    }));
    const value = fitScanDetails({
      ...context,
      finding_breakdown_version: 1,
      finding_breakdown_status: "complete",
      finding_groups: groups,
      finding_omitted_count: 0,
      finding_unmapped_count: 0,
      finding_counts_clipped: false,
      completed_check_ids: ["types"],
    });
    expect(value.finding_groups!.length).toBeLessThanOrEqual(256);
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThanOrEqual(
      16_384,
    );
    expect(
      value.finding_groups!.reduce((sum, row) => sum + row.count, 0) +
        value.finding_omitted_count!,
    ).toBe(300);
    expect(value.finding_breakdown_status).toBe("truncated");
  });
});
describe("v2 wire boundary", () => {
  const base = {
    schema_version: 1,
    event: "scan_finished",
    event_id: randomUUID(),
    run_id: randomUUID(),
    timestamp: new Date().toISOString(),
    version: "0.1.0",
    os: "linux",
    arch: "x64",
    node_major: 24,
    command: "scan",
    environment: "ci_not_detected",
    installation_id: randomUUID(),
    invocation_source: "unspecified",
    outcome: "blocked",
    duration_ms: 1,
    finding_count: 1,
  };
  const details = {
    ...context,
    ...summarizeFindings(report([finding("no-unused-vars")])),
  };
  it("accepts enriched finishes while keeping the legacy outbox strict", () => {
    const enriched = { ...base, ...details, schema_version: 2 };
    expect(telemetryEventSchema.safeParse(enriched).success).toBe(true);
    expect(telemetryV1EventSchema.safeParse(enriched).success).toBe(false);
    expect(telemetryV1EventSchema.safeParse(base).success).toBe(true);
  });
  it("rejects model fields, arbitrary nested labels, and inconsistent counts", () => {
    for (const extra of [
      { model: "a-model" },
      { finding_count: 5 },
      { finding_groups: [{ ...details.finding_groups![0], label: "PRIVATE" }] },
    ]) {
      expect(
        telemetryEventSchema.safeParse({
          ...base,
          ...details,
          schema_version: 2,
          ...extra,
        }).success,
      ).toBe(false);
    }
    expect(
      scanDetailsSchema.safeParse({
        ...context,
        finding_breakdown_version: 1,
        finding_breakdown_status: "unavailable",
      }).success,
    ).toBe(true);
    expect(
      scanDetailsSchema.safeParse({
        ...context,
        finding_breakdown_version: 1,
        finding_breakdown_status: "unavailable",
        finding_groups: [],
      }).success,
    ).toBe(false);
  });
});
