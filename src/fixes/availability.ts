import type { FixPlan } from "./types.js";

export function hasApplicableFixes(plan: FixPlan): boolean {
  return plan.items.some((item) => item.status !== "skipped");
}
