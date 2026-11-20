import { describe, expect, it } from "vitest";
import { assertUpgradeCommit } from "../../scripts/smoke-consumer-upgrade.mjs";
import { verifyUpgradeEvidence } from "../../scripts/tag-tested-release.mjs";

describe("release upgrade evidence", () => {
  const identity = {
    commit: "a".repeat(40),
    version: "0.1.0-beta.19",
    sha256: "b".repeat(64),
  };
  const evidence = {
    ...identity,
    upgradedFrom: ["0.1.0-beta.15", "0.1.0-beta.18"],
  };
  it("accepts the tested commit and archive", () => {
    expect(() => verifyUpgradeEvidence(evidence, identity)).not.toThrow();
  });
  it.each(["commit", "version", "sha256"] as const)(
    "rejects a changed %s",
    (key) => {
      expect(() =>
        verifyUpgradeEvidence(evidence, { ...identity, [key]: "changed" }),
      ).toThrow(key);
    },
  );
  it("requires a passing prior-version rehearsal", () => {
    expect(() =>
      verifyUpgradeEvidence({ ...evidence, upgradedFrom: [] }, identity),
    ).toThrow(/successful upgrades/u);
  });
});

describe("release test hook outcome", () => {
  const expected = { workspace: "web", files: 2, skipped: "e2e" };
  const checks = ["lint", "types"].flatMap((checkId) => [
    {
      checkId,
      target: "web",
      status: "completed",
      findings: [],
      comparisonContext: { status: "comparable" },
    },
    { checkId, target: "e2e", status: "skipped", findings: [] },
  ]);
  const report = {
    mode: "index",
    outcome: "pass",
    exitCode: 0,
    changedFileCount: 2,
    checks,
  };
  it("accepts an upgrade commit with the expected coverage", () => {
    expect(() => assertUpgradeCommit(report, expected)).not.toThrow();
  });
  it("rejects an incomplete comparison even if the hook reports a pass", () => {
    const incomplete = [...checks, { ...checks[0], status: "incomplete" }];
    expect(() =>
      assertUpgradeCommit({ ...report, checks: incomplete }, expected),
    ).toThrow();
  });
  it("rejects a pass when a real compiler error was staged", () => {
    expect(() =>
      assertUpgradeCommit(report, { ...expected, error: true }),
    ).toThrow();
  });
});
