import type { AgentGuidance } from "./agent-guidance.js";
import type { TerminalPresentation } from "./presentation.js";

export type ReportCalloutLine =
  | Readonly<{ kind: "text"; value: string }>
  | Readonly<{ kind: "report-path"; path: string }>;

export interface ReportCallouts {
  readonly opening: readonly ReportCalloutLine[];
  readonly closing: readonly ReportCalloutLine[];
}

const UNAVAILABLE_CALLOUTS: ReportCallouts = Object.freeze({
  opening: Object.freeze([
    Object.freeze({ kind: "text" as const, value: "REPORT UNAVAILABLE" }),
    Object.freeze({
      kind: "text" as const,
      value: "The terminal output is the complete source of truth.",
    }),
  ]),
  closing: Object.freeze([
    Object.freeze({ kind: "text" as const, value: "REPORT UNAVAILABLE" }),
    Object.freeze({
      kind: "text" as const,
      value: "The terminal output is the complete source of truth.",
    }),
  ]),
});

function availableCallout(
  heading: "AGENT GUIDANCE" | "AGENT NEXT STEP",
  guidance: string,
  path: string,
): readonly ReportCalloutLine[] {
  return Object.freeze([
    ...(guidance === ""
      ? []
      : [
          Object.freeze({ kind: "text" as const, value: heading }),
          Object.freeze({ kind: "text" as const, value: guidance }),
        ]),
    Object.freeze({ kind: "text" as const, value: "COMPLETE REPORT" }),
    Object.freeze({ kind: "report-path" as const, path }),
  ]);
}

export function buildReportCallouts(
  presentation: TerminalPresentation,
  guidance: AgentGuidance,
): ReportCallouts {
  if (
    !presentation.automatic ||
    presentation.reportStatus === "not-requested"
  ) {
    return Object.freeze({
      opening: Object.freeze([]),
      closing: Object.freeze([]),
    });
  }
  if (presentation.reportStatus === "unavailable") return UNAVAILABLE_CALLOUTS;
  if (presentation.reportPath === undefined) {
    throw new TypeError("An available report requires a report path");
  }
  return Object.freeze({
    opening: availableCallout(
      "AGENT GUIDANCE",
      guidance.opening,
      presentation.reportPath,
    ),
    closing: availableCallout(
      "AGENT NEXT STEP",
      guidance.nextStep,
      presentation.reportPath,
    ),
  });
}
