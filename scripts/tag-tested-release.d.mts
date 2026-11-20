export function verifyUpgradeEvidence(
  evidence: unknown,
  identity: Readonly<{ commit: string; version: string; sha256: string }>,
): void;
