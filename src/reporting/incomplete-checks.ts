import { INSTALLATION_CONTEXTUAL_PREFIX } from "../checks/installation-diagnostic.js";
import type { CheckResult, StructuralParseFailures } from "../core/types.js";
import type { ScanReport } from "../scan/report.js";
import { checkLabel, findingCheckLabel } from "./check-label.js";

interface DiagnosticField {
  readonly label: string;
  readonly value: string;
}

export interface IncompleteCheckPresentation {
  readonly title: string;
  readonly fields: readonly DiagnosticField[];
}

type Comparison = Pick<ScanReport, "mode" | "mergeParents">;

function comparisonLabel(
  error: NonNullable<CheckResult["error"]>,
  comparison: Comparison,
): string | undefined {
  if (error.snapshot === undefined) return undefined;
  if (comparison.mergeParents !== undefined) {
    if (error.snapshot === "staged") return "Staged merge";
    return error.comparisonParent === undefined
      ? "Merge parent"
      : `Merge parent ${error.comparisonParent.slice(0, 12)}`;
  }
  if (comparison.mode === "base")
    return error.snapshot === "last-commit" ? "Merge base" : "Selected commit";
  return error.snapshot === "last-commit" ? "Previous commit" : "Staged files";
}

function parseFailureFields(
  failures: StructuralParseFailures,
): DiagnosticField[] {
  const fields = failures.files.slice(0, 10).map((file) => ({
    label:
      file.snapshot === "staged"
        ? "Staged"
        : file.snapshot === "baseline"
          ? "Baseline"
          : "Target",
    value: `${file.path}:${file.line}:${file.column} · ${file.reason}`,
  }));
  if (failures.files.length > 10) {
    fields.push({
      label: "More",
      value: `${failures.files.length - 10} more. Use --format json for all recorded failures.`,
    });
  }
  if (failures.omitted > 0) {
    fields.push({
      label: "Limit",
      value: `${failures.omitted} additional parse failures exceeded the report limit.`,
    });
  }
  return fields;
}

function problemFields(
  check: CheckResult,
  checkIds: ReadonlySet<string>,
  comparison: Comparison,
): DiagnosticField[] {
  const fields: DiagnosticField[] = [];
  const add = (label: string, value: string | undefined): void => {
    if (value !== undefined) fields.push({ label, value });
  };
  const error = check.error;
  if (error === undefined) return fields;
  add("Issue", error.message);
  if (error.code === "COMPARISON_INSTALLATION_UNAVAILABLE")
    add("Checks", [...checkIds].map(checkLabel).join(", "));
  if (error.parseFailures === undefined) add("Path", error.path);
  add("Checked version", comparisonLabel(error, comparison));
  if (error.projectPaths !== undefined) {
    add(
      error.projectPaths.length === 1 ? "Loaded project" : "Loaded projects",
      error.projectPaths.join(", "),
    );
  }
  if (error.parseFailures !== undefined) {
    fields.push(...parseFailureFields(error.parseFailures));
  } else if (error.paths !== undefined) {
    add("Affected files", String(error.paths.length));
    for (const path of error.paths.slice(0, 10)) add("File", path);
    if (error.paths.length > 10)
      add("More files", String(error.paths.length - 10));
  }
  add("Cleanup", error.temporaryPath);
  add("Fix", error.remediation);
  if (check.incompleteDisposition !== undefined) {
    const action =
      check.incompleteDisposition === "block"
        ? "commit blocked"
        : "commit allowed";
    add(
      "Availability",
      `${action} (onUnavailable: ${check.incompleteDisposition})`,
    );
  }
  return fields;
}

export function presentIncompleteChecks(
  checks: readonly CheckResult[],
  comparison: Comparison = { mode: "index" },
): IncompleteCheckPresentation[] {
  const grouped = new Map<
    string | number,
    { check: CheckResult; checkIds: Set<string> }
  >();
  for (const [index, check] of checks.entries()) {
    if (check.status !== "incomplete") continue;
    const { error } = check;
    // Redacted errors may name different packages. Only combine known causes.
    const key =
      error?.code === "COMPARISON_INSTALLATION_UNAVAILABLE" &&
      error.message.startsWith(INSTALLATION_CONTEXTUAL_PREFIX) &&
      error.path !== undefined &&
      (comparison.mergeParents === undefined ||
        error.snapshot !== "last-commit" ||
        error.comparisonParent !== undefined)
        ? JSON.stringify([
            check.target,
            error.message,
            error.path,
            error.remediation,
            error.snapshot,
            error.comparisonParent,
            check.incompleteDisposition,
          ])
        : index;
    const matching = grouped.get(key);
    if (matching === undefined) {
      grouped.set(key, { check, checkIds: new Set([check.checkId]) });
    } else {
      matching.checkIds.add(check.checkId);
    }
  }
  return [...grouped.values()].map(({ check, checkIds }) => ({
    title:
      check.error?.code.replaceAll("_", " ") ??
      `${findingCheckLabel(check.checkId).toUpperCase()} INCOMPLETE`,
    fields: problemFields(check, checkIds, comparison),
  }));
}
