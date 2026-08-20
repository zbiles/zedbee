import {
  canonicalDisplayText,
  DISPLAY_TEXT_LIMITS,
} from "../core/display-text.js";

export function validateTemporaryReportPath(value: unknown): string {
  return canonicalDisplayText(
    value,
    "temporary report path",
    DISPLAY_TEXT_LIMITS.prose,
  );
}

export function opaqueTemporaryReportPath(value: unknown): string {
  return JSON.stringify(validateTemporaryReportPath(value)).replaceAll(
    " ",
    "\\u0020",
  );
}
