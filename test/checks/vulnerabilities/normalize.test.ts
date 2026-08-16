import { describe, expect, it } from "vitest";
import { normalizeOsvReport } from "../../../src/checks/vulnerabilities/normalize.js";

const targetRoot = "/tmp/zedbee-target";

function report(version = "4.17.20", score = "8.1"): string {
  return JSON.stringify({
    results: [
      {
        source: {
          path: `${targetRoot}/packages/web/package-lock.json`,
          type: "lockfile",
        },
        packages: [
          {
            package: { name: "lodash", version, ecosystem: "npm" },
            vulnerabilities: [
              {
                id: "GHSA-35jh-r3h4-6jhm",
                severity: [{ type: "CVSS_V3", score }],
                affected: [
                  {
                    package: { name: "lodash", ecosystem: "npm" },
                    ranges: [
                      {
                        type: "SEMVER",
                        events: [{ introduced: "0" }, { fixed: "4.17.21" }],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
  });
}

describe("normalizeOsvReport", () => {
  it("creates safe, actionable vulnerability observations", () => {
    expect(normalizeOsvReport(report(), targetRoot)).toEqual([
      {
        check: "vulnerabilities",
        rule: "GHSA-35jh-r3h4-6jhm",
        identity:
          '["GHSA-35jh-r3h4-6jhm","npm","lodash","packages/web/package-lock.json"]',
        severity: "error",
        message:
          "GHSA-35jh-r3h4-6jhm affects npm package lodash@4.17.20; fixed in 4.17.21 (https://osv.dev/GHSA-35jh-r3h4-6jhm)",
        location: { file: "packages/web/package-lock.json" },
        metric: { name: "cvss", value: 8.1 },
        remediation: "Upgrade lodash to 4.17.21 or later.",
      },
    ]);
  });

  it("keeps identity stable when the vulnerable version changes", () => {
    const before = normalizeOsvReport(report("4.17.19"), targetRoot)[0];
    const after = normalizeOsvReport(report("4.17.20"), targetRoot)[0];

    expect(after?.identity).toBe(before?.identity);
    expect(after?.message).not.toBe(before?.message);
  });

  it("uses the maximum numeric severity and omits invalid numeric data", () => {
    const multiple = JSON.parse(report()) as {
      results: Array<{
        packages: Array<{
          vulnerabilities: Array<{ severity: Array<unknown> }>;
        }>;
      }>;
    };
    multiple.results[0]!.packages[0]!.vulnerabilities[0]!.severity = [
      { type: "CVSS_V2", score: "5.5" },
      { type: "CVSS_V3", score: "9.8" },
      { type: "CVSS_V4", score: "not-a-number" },
    ];
    expect(
      normalizeOsvReport(JSON.stringify(multiple), targetRoot)[0]?.metric,
    ).toEqual({ name: "cvss", value: 9.8 });
  });

  it("rejects source paths outside the snapshot without exposing them", () => {
    const outside = report().replaceAll(targetRoot, "/private/sensitive");
    expect(() => normalizeOsvReport(outside, targetRoot)).toThrow(
      "OSV-Scanner returned an invalid report",
    );
    try {
      normalizeOsvReport(outside, targetRoot);
    } catch (error) {
      expect(String(error)).not.toContain("/private/sensitive");
    }
  });
});
