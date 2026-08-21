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
