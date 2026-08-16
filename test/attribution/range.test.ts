import { describe, expect, it } from "vitest";
import { attributeByRange } from "../../src/attribution/range.js";
import type { Finding } from "../../src/core/types.js";
import type { ChangeSet } from "../../src/git/change-set.js";

function finding(file?: string, startLine?: number, endLine?: number): Finding {
  return {
    id: "finding-1",
    check: "formatting",
    rule: "rule",
    severity: "error",
    message: "Finding",
    ...(file === undefined
      ? {}
      : {
          location: {
            file,
            ...(startLine === undefined ? {} : { startLine }),
            ...(endLine === undefined ? {} : { endLine })
          }
        }),
    attribution: { kind: "none", staged: false, evidence: [] }
  };
}

const changeSet: ChangeSet = {
  files: new Map([
    [
      "src/value.ts",
      {
        path: "src/value.ts",
        status: "modified",
        addedRanges: [{ start: 5, end: 5 }]
      }
    ]
  ]),
  isEmpty: false,
  containsAddedLine(file, line) {
    return file.replaceAll("\\", "/") === "src/value.ts" && line === 5;
  }
};

describe("attributeByRange", () => {
  it("attributes a finding whose reported range overlaps a staged line", () => {
    expect(attributeByRange(finding("src/value.ts", 4, 6), changeSet)).toMatchObject({
      id: "finding-1",
      attribution: {
        kind: "range-overlap",
        staged: true,
        evidence: ["src/value.ts:4-6 overlaps staged lines 5-5"]
      }
    });
  });

  it("does not attribute a finding elsewhere in a changed file", () => {
    expect(attributeByRange(finding("src/value.ts", 8, 9), changeSet).attribution).toEqual({
      kind: "none",
      staged: false,
      evidence: []
    });
  });

  it("does not attribute a finding without a precise line", () => {
    expect(attributeByRange(finding("src/value.ts"), changeSet).attribution.staged).toBe(false);
    expect(attributeByRange(finding(), changeSet).attribution.staged).toBe(false);
  });

  it("normalizes Windows separators before matching", () => {
    expect(
      attributeByRange(finding("src\\value.ts", 5, 5), changeSet).attribution.staged
    ).toBe(true);
  });
});
