import type { CheckTarget } from "./adapter.js";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import { displayLabel } from "../core/display-text.js";

export const PUBLIC_CHECK_TARGET_FIELDS = {
  id: true,
  kind: true,
  relativeRoot: true,
} as const satisfies Readonly<Record<keyof CheckTarget, true>>;

export function sanitizeCheckTarget(
  target: CheckTarget,
): Readonly<CheckTarget> {
  const id = target.id;
  const kind = target.kind;
  const relativeRoot = target.relativeRoot;

  if (
    typeof id !== "string" ||
    (kind !== "repository" && kind !== "workspace") ||
    typeof relativeRoot !== "string"
  ) {
    throw new TypeError("Adapter returned an invalid check target");
  }

  const safeId = displayLabel(id, "target id");
  if (
    (kind === "repository" && relativeRoot !== ".") ||
    (kind === "workspace" &&
      relativeRoot !== "." &&
      normalizeRepositoryRelativePath(relativeRoot) !== relativeRoot)
  ) {
    throw new TypeError("Adapter returned a non-canonical check target");
  }

  return Object.freeze({ id: safeId, kind, relativeRoot });
}
