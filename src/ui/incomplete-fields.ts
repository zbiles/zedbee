import { parseFailureFields } from "../renderers/incomplete.js";
import type { CheckError, CheckResult } from "../core/types.js";
import { findingCheckLabel } from "../reporting/check-label.js";

export interface IncompleteField {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  readonly emphasis: "primary" | "secondary";
}

export function incompleteCheckTitle(check: CheckResult): string {
  return (
    check.error?.code.replaceAll("_", " ") ??
    `${findingCheckLabel(check.checkId).toUpperCase()} INCOMPLETE`
  );
}

export function incompleteErrorFields(error: CheckError): IncompleteField[] {
  const fields: IncompleteField[] = [];
  fields.push({
    key: "0:Issue",
    label: "Issue",
    value: error.message,
    emphasis: "primary",
  });
  if (error.path !== undefined && error.parseFailures === undefined) {
    fields.push({ key: "1:Path", label: "Path", value: error.path, emphasis: "secondary" });
  }
  if (error.snapshot !== undefined) {
    fields.push({
      key: "2:Checked version",
      label: "Checked version",
      value:
        error.snapshot === "last-commit" ? "Previous commit" : "Staged files",
      emphasis: "secondary",
    });
  }
  if (error.projectPaths !== undefined) {
    fields.push({
      key: "3:Loaded project(s)",
      label:
        error.projectPaths.length === 1 ? "Loaded project" : "Loaded projects",
      value: error.projectPaths.join(", "),
      emphasis: "secondary",
    });
  }
  if (error.parseFailures !== undefined) {
    for (const [index, failure] of parseFailureFields(error.parseFailures).entries()) {
      fields.push({
        key: `4:${index}:${failure.label}`,
        label: failure.label,
        value: failure.value,
        emphasis: "secondary",
      });
    }
  } else if (error.paths !== undefined) {
    fields.push({
      key: "5:Affected files",
      label: "Affected files",
      value: String(error.paths.length),
      emphasis: "secondary",
    });
    for (const path of error.paths.slice(0, 10)) {
      fields.push({
        key: `5:File:${path}`,
        label: "File",
        value: path,
        emphasis: "secondary",
      });
    }
    if (error.paths.length > 10) {
      fields.push({
        key: "5:More files",
        label: "More files",
        value: String(error.paths.length - 10),
        emphasis: "secondary",
      });
    }
  }
  if (error.temporaryPath !== undefined) {
    fields.push({
      key: "6:Cleanup",
      label: "Cleanup",
      value: error.temporaryPath,
      emphasis: "secondary",
    });
  }
  if (error.remediation !== undefined) {
    fields.push({
      key: "7:Fix",
      label: "Fix",
      value: error.remediation,
      emphasis: "primary",
    });
  }
  return fields;
}
