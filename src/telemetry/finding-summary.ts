import type { ScanReport } from "../scan/report.js";
import {
  TELEMETRY_CHECK_IDS,
  type FindingGroup,
  type ScanDetails,
} from "./schema.js";
import { allowedFindingRule } from "./finding-rules.js";

const MAX_COUNT = 1_000_000;
type BreakdownKey =
  | "finding_breakdown_version"
  | "finding_breakdown_status"
  | "finding_groups"
  | "finding_unmapped_count"
  | "finding_omitted_count"
  | "finding_counts_clipped"
  | "completed_check_ids";
export type FindingBreakdown = Pick<ScanDetails, BreakdownKey>;
export function summarizeFindings(
  report: Pick<ScanReport, "summary" | "checks">,
): FindingBreakdown {
  const groups = new Map<string, FindingGroup>();
  let unmapped = 0;
  for (const finding of report.summary.findings) {
    if (
      !TELEMETRY_CHECK_IDS.includes(finding.check as never) ||
      !allowedFindingRule(finding.check, finding.rule) ||
      !["info", "warning", "error"].includes(finding.severity)
    ) {
      unmapped++;
      continue;
    }
    const key = JSON.stringify([finding.check, finding.rule, finding.severity]);
    const existing = groups.get(key);
    if (existing) existing.count++;
    else
      groups.set(key, {
        check_id: finding.check as FindingGroup["check_id"],
        rule_id: finding.rule,
        severity: finding.severity,
        count: 1,
      });
  }
  return {
    finding_breakdown_version: 1,
    finding_breakdown_status:
      unmapped > 0 || report.summary.findings.length > MAX_COUNT
        ? "truncated"
        : "complete",
    finding_groups: [...groups.values()].map((row) => ({
      ...row,
      count: Math.min(MAX_COUNT, row.count),
    })),
    finding_unmapped_count: Math.min(MAX_COUNT, unmapped),
    finding_omitted_count: 0,
    finding_counts_clipped: report.summary.findings.length > MAX_COUNT,
    completed_check_ids: TELEMETRY_CHECK_IDS.filter(
      (id) =>
        report.checks.some(
          (check) => check.checkId === id && check.status === "completed",
        ) &&
        !report.checks.some(
          (check) => check.checkId === id && check.status === "incomplete",
        ),
    ),
  };
}
export function fitScanDetails(details: ScanDetails): ScanDetails {
  const value = structuredClone(details);
  if (value.finding_breakdown_status === "unavailable") return value;
  value.finding_groups?.sort(
    (a, b) =>
      b.count - a.count ||
      compare(
        [a.check_id, a.rule_id, a.severity].join("\0"),
        [b.check_id, b.rule_id, b.severity].join("\0"),
      ),
  );
  while (
    (value.finding_groups?.length ?? 0) > 256 ||
    Buffer.byteLength(JSON.stringify(value)) > 16_384
  ) {
    const removed = value.finding_groups?.pop();
    if (!removed) throw new Error("Scan details exceed metadata budget");
    const omitted = (value.finding_omitted_count ?? 0) + removed.count;
    value.finding_counts_clipped ||= omitted > MAX_COUNT;
    value.finding_omitted_count = Math.min(MAX_COUNT, omitted);
    value.finding_breakdown_status = "truncated";
  }
  return value;
}
function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
