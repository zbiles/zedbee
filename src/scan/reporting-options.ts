import type { SourceExcerptPolicy } from "../config/schema.js";

export type SourceExcerptOverride = "include" | "exclude";
export type RequestedOutputFormat = "auto" | "ink" | "text" | "json" | "sarif";
export type ReportingSurface = Exclude<RequestedOutputFormat, "auto">;

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

export function shouldPersistSourceExcerpts(
  policy: SourceExcerptPolicy,
  override: SourceExcerptOverride | undefined,
): boolean {
  if (override === "include") return true;
  if (override === "exclude") return false;
  return policy === "always";
}
