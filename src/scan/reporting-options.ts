import type { SourceExcerptPolicy } from "../config/schema.js";

export type SourceExcerptOverride = "include" | "exclude";
export type ReportingSurface = "ink" | "text" | "json";

export function shouldIncludeSourceExcerpts(
  policy: SourceExcerptPolicy,
  surface: ReportingSurface | undefined,
  override: SourceExcerptOverride | undefined,
): boolean {
  if (surface === undefined) return false;
  if (override === "include") return true;
  if (override === "exclude") return false;
  if (policy === "always") return true;
  return policy === "interactive" && surface === "ink";
}
