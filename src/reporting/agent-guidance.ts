import { displayProse } from "../core/display-text.js";

export interface AgentGuidance {
  readonly opening: string;
  readonly nextStep: string;
}

export const EMPTY_AGENT_GUIDANCE: AgentGuidance = Object.freeze({
  opening: "",
  nextStep: "",
});

export const RECOMMENDED_AGENT_GUIDANCE: AgentGuidance = Object.freeze({
  opening:
    "Use the complete JSON report as the source of truth. Do not rely only on this terminal summary. Follow the report outcome and review all recorded details.",
  nextStep:
    "Fix every blocking finding, review warnings separately, and resolve any incomplete checks. Stage any changes and run Zedbee again. Do not bypass the pre-commit hook.",
});

export function normalizeAgentGuidance(
  input:
    | Readonly<{
        opening?: string | undefined;
        nextStep?: string | undefined;
      }>
    | undefined,
): AgentGuidance {
  const normalize = (value: string | undefined, field: string): string =>
    displayProse(value ?? "", field, { allowEmpty: true }).trim();
  return Object.freeze({
    opening: normalize(input?.opening, "agent guidance opening"),
    nextStep: normalize(input?.nextStep, "agent guidance next step"),
  });
}

export function resolveAgentNextStep(
  report: import("../scan/report.js").ScanReport,
  guidance: AgentGuidance,
): string {
  if (guidance.nextStep !== RECOMMENDED_AGENT_GUIDANCE.nextStep)
    return guidance.nextStep;
  const steps: string[] = [];
  if (report.summary.failed > 0) steps.push("Fix every blocking finding.");
  if (report.summary.warnings > 0) steps.push("Review warnings separately.");
  if (
    report.summary.incomplete > 0 ||
    report.checks.some((check) => check.status === "incomplete")
  )
    steps.push("Resolve any incomplete checks.");
  if (steps.length > 0) {
    steps.push(
      report.mode === "base"
        ? "Commit any fixes and run Zedbee again."
        : "Stage any fixes and run Zedbee again.",
    );
    steps.push("Do not bypass the pre-commit hook.");
    return steps.join(" ");
  }
  if (
    report.changedFileCount === 0 ||
    !report.checks.some((check) => check.status === "completed")
  ) {
    const scope =
      report.mode === "base" ? "selected committed changes" : "staged changes";
    return `Review the ${scope}; no configured checks ran.`;
  }
  return "No findings require action.";
}
