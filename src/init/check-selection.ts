import { CHECK_IDS, isCheckId, type CheckId } from "../core/check-ids.js";
export function parseCheckSelection(value: string): readonly CheckId[] {
  const requested = value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  const unknown = requested.filter((item) => !isCheckId(item));
  if (requested.length === 0 || unknown.length > 0) {
    throw new Error(
      `Checks must be a comma-separated subset of: ${CHECK_IDS.join(", ")}`,
    );
  }
  const selected = new Set(requested as CheckId[]);
  return Object.freeze(CHECK_IDS.filter((check) => selected.has(check)));
}
