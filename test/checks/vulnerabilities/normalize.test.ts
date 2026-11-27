import { describe, expect, it } from "vitest";
import { normalizeOsvInventory } from "../../../src/checks/vulnerabilities/normalize.js";
import { osvQueryKey } from "../../../src/checks/vulnerabilities/osv/client.js";
import type { OsvAdvisory } from "../../../src/checks/vulnerabilities/osv/types.js";

const dependency = {
  name: "lodash",
  version: "4.17.20",
  ecosystem: "npm" as const,
  lockfilePath: "packages/web/package-lock.json",
  line: 42,
  importer: "packages/web",
  dependencyPath: ["web", "lodash"],
};

function advisory(score = "8.1"): OsvAdvisory {
  return {
    id: "GHSA-35jh-r3h4-6jhm",
    aliases: [],
    affected: [
      {
        package: { name: "lodash", ecosystem: "npm" },
        ranges: [
          {
            type: "SEMVER",
            events: [{ introduced: "0" }, { fixed: "4.17.21" }],
          },
        ],
        versions: [],
      },
    ],
    severity: [{ type: "CVSS_V3", score }],
    references: [],
  };
}

describe("normalizeOsvInventory", () => {
  it("creates safe, actionable, line-attributed observations", () => {
    const observations = normalizeOsvInventory(
      [dependency],
      new Map([[osvQueryKey(dependency), [advisory()]]]),
    );
    expect(observations).toEqual([
      {
        check: "vulnerabilities",
        rule: "GHSA-35jh-r3h4-6jhm",
        identity:
          '["GHSA-35jh-r3h4-6jhm","npm","lodash","4.17.20","packages/web/package-lock.json","packages/web",["web","lodash"]]',
        comparisonIdentity:
          '["GHSA-35jh-r3h4-6jhm","npm","lodash","4.17.20","packages/web/package-lock.json","packages/web",["web","lodash"]]',
        severity: "error",
        message:
          "GHSA-35jh-r3h4-6jhm affects npm package lodash@4.17.20; fixed in 4.17.21 (https://osv.dev/GHSA-35jh-r3h4-6jhm)",
        location: { file: "packages/web/package-lock.json", startLine: 42 },
        metric: { name: "cvss", value: 8.1 },
        remediation: "Upgrade lodash to 4.17.21 or later.",
      },
    ]);
  });

  it("changes identity for version and dependency context changes", () => {
    const first = normalizeOsvInventory(
      [dependency],
      new Map([[osvQueryKey(dependency), [advisory()]]]),
    )[0];
    const upgraded = { ...dependency, version: "4.17.21" };
    const moved = { ...dependency, dependencyPath: ["other", "lodash"] };
    expect(
      normalizeOsvInventory(
        [upgraded],
        new Map([[osvQueryKey(upgraded), [advisory()]]]),
      )[0]?.identity,
    ).not.toBe(first?.identity);
    expect(
      normalizeOsvInventory(
        [moved],
        new Map([[osvQueryKey(moved), [advisory()]]]),
      )[0]?.identity,
    ).not.toBe(first?.identity);
  });

  it("picks the lowest semver fixed version above the installed version", () => {
    const lodash = {
      ...dependency,
      name: "lodash",
      version: "2.0.0",
    };
    const advisories: OsvAdvisory[] = [
      {
        id: "GHSA-matrix",
        aliases: [],
        affected: [
          {
            package: { name: "lodash", ecosystem: "npm" },
            ranges: [
              {
                type: "SEMVER",
                events: [
                  { introduced: "0.0.0" },
                  { fixed: "1.2.3" },
                  { introduced: "1.5.0" },
                  { fixed: "2.10.0" },
                  { introduced: "2.5.0" },
                  { fixed: "2.9.0" },
                ],
              },
            ],
            versions: [],
          },
        ],
        severity: [{ type: "CVSS_V3", score: "8.1" }],
        references: [],
      },
    ];
    expect(
      normalizeOsvInventory(
        [lodash],
        new Map([[osvQueryKey(lodash), advisories]]),
      )[0]?.remediation,
    ).toBe("Upgrade lodash to 2.9.0 or later.");
  });

  it("omits remediation when every fixed version is already installed", () => {
    const installed = { ...dependency, version: "4.17.21" };
    const observations = normalizeOsvInventory(
      [installed],
      new Map([[osvQueryKey(installed), [advisory()]]]),
    );
    expect(observations[0]).not.toHaveProperty("remediation");
    expect(observations[0]?.message).not.toContain("fixed in");
  });

  it("uses the maximum valid numeric CVSS value and ignores invalid values", () => {
    const multiple = {
      ...advisory(),
      severity: [
        { type: "CVSS_V2", score: "5.5" },
        { type: "CVSS_V3", score: "9.8" },
        { type: "CVSS_V4", score: "not-a-number" },
      ],
    };
    expect(
      normalizeOsvInventory(
        [dependency],
        new Map([[osvQueryKey(dependency), [multiple]]]),
      )[0]?.metric,
    ).toEqual({ name: "cvss", value: 9.8 });
  });
});
