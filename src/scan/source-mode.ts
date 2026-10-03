import { isGitObjectId, safeRequestedBase } from "../git/base-ref.js";

export type ScanMode = "index" | "base";

export interface ScanSourceIdentity {
  readonly mode: ScanMode;
  readonly baseline: "HEAD" | string | null;
  readonly target: "index" | string | null;
  readonly requestedBase?: string;
  readonly mergeParents?: readonly string[];
}

export function sanitizeScanSourceIdentity(
  source: ScanSourceIdentity,
): ScanSourceIdentity {
  if (source.mode === "base") {
    const requestedBase = safeRequestedBase(source.requestedBase);
    return {
      mode: "base",
      baseline: isGitObjectId(source.baseline) ? source.baseline : null,
      target: isGitObjectId(source.target) ? source.target : null,
      ...(requestedBase === undefined ? {} : { requestedBase }),
    };
  }
  return {
    mode: "index",
    baseline:
      source.baseline === "HEAD" || isGitObjectId(source.baseline)
        ? source.baseline
        : null,
    target: "index",
    ...(Array.isArray(source.mergeParents) &&
    source.mergeParents.length >= 2 &&
    source.mergeParents.length <= 101 &&
    source.mergeParents.every(isGitObjectId)
      ? { mergeParents: Object.freeze([...source.mergeParents]) }
      : {}),
  };
}
