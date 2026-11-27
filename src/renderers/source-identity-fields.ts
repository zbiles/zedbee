import type { ScanSourceIdentity } from "../scan/source-mode.js";

export function sourceIdentityFields(
  source: ScanSourceIdentity,
): Record<string, unknown> {
  return {
    mode: source.mode,
    baseline: source.baseline,
    target: source.target,
    ...(source.mergeParents === undefined
      ? {}
      : { mergeParents: source.mergeParents }),
    ...(source.requestedBase === undefined
      ? {}
      : { requestedBase: source.requestedBase }),
  };
}
