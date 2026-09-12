import { describe, expect, it } from "vitest";
import { parseKnipReport } from "../../../src/checks/dead-code/parse-report.js";

describe("parseKnipReport", () => {
  it.each(["dependencies", "devDependencies"])(
    "treats Zedbee in %s as an intentional CLI tool, including workspace manifests",
    (field) => {
      for (const file of ["package.json", "web/package.json"]) {
        const result = parseKnipReport(
          {
            issues: [
              {
                file,
                [field]: [
                  { name: "zedbee" },
                  { name: "another-tool" },
                  { name: "zedbee-helper" },
                ],
                unlisted: [{ name: "zedbee" }],
                unresolved: [{ name: "zedbee" }],
                exports: [{ name: "zedbee" }],
              },
            ],
          },
          new Set([file]),
        );
        expect(
          result
            .filter((item) => item.rule === field)
            .map((item) => item.entity?.name),
        ).toEqual(["another-tool", "zedbee-helper"]);
        expect(
          result
            .filter((item) => item.entity?.name === "zedbee")
            .map((item) => item.rule),
        ).toEqual(["exports", "unlisted", "unresolved"]);
      }
    },
  );

  it("normalizes every managed Knip issue without source text", () => {
    const report = {
      issues: [
        {
          file: "src/a.ts",
          files: [{ name: "src/a.ts" }],
          exports: [{ name: "unused", line: 2, col: 7 }],
          types: [{ name: "UnusedType", line: 3, col: 1 }],
          nsExports: [{ name: "unusedNamespace", line: 3, col: 2 }],
          nsTypes: [{ name: "UnusedNamespaceType", line: 3, col: 3 }],
          unresolved: [{ name: "./missing.js", line: 4, col: 2 }],
          duplicates: [[{ name: "one" }, { name: "two" }]],
        },
        {
          file: "package.json",
          dependencies: [{ name: "left-pad" }],
          devDependencies: [{ name: "vitest" }],
          unlisted: [{ name: "missing-package" }],
        },
      ],
    };
    const observations = parseKnipReport(
      report,
      new Set(["src/a.ts", "package.json"]),
    );
    expect(observations).toHaveLength(10);
    expect(observations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          rule: "exports",
          entity: {
            kind: "knip-exports",
            name: "unused",
            file: "src/a.ts",
          },
          location: { file: "src/a.ts", startLine: 2, startColumn: 7 },
        }),
        expect.objectContaining({
          rule: "dependencies",
          location: { file: "package.json" },
        }),
      ]),
    );
    expect(JSON.stringify(observations)).not.toContain("secret source");
  });

  it("fails closed on malformed, unsafe, and unowned output", () => {
    expect(() => parseKnipReport({}, new Set())).toThrow(/issues/i);
    expect(() =>
      parseKnipReport(
        { issues: [{ file: "../outside.ts", files: [{ name: "x" }] }] },
        new Set(["src/a.ts"]),
      ),
    ).toThrow();
    expect(() =>
      parseKnipReport(
        { issues: [{ file: "src/a.ts", exports: [{ name: "bad\nname" }] }] },
        new Set(["src/a.ts"]),
      ),
    ).toThrow(/canonical/i);
  });
});
