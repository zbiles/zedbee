import { describe, expect, it } from "vitest";
import { compareCloneOccurrences } from "../../../src/checks/duplication/clone-comparison.js";
import type {
  DuplicationSourceIndex,
  SourceToken,
} from "../../../src/checks/duplication/source-tokens.js";
import type { NormalizedDuplicationReport } from "../../../src/checks/duplication/types.js";
import type { ChangeSet } from "../../../src/git/change-set.js";

const changes: ChangeSet = {
  files: new Map(),
  isEmpty: true,
  containsAddedLine: () => false,
};
function index(text: string): DuplicationSourceIndex {
  const tokens: SourceToken[] = [...text.matchAll(/\w+/g)].map((match) => ({
    kind: 1,
    text: match[0],
    start: match.index,
    end: match.index + match[0].length,
    line: 1,
  }));
  return new Map(
    ["a.ts", "b.ts"].map((file) => [file, { file, tokens, text, valid: true }]),
  );
}
function report(percentage: number): NormalizedDuplicationReport {
  return {
    percentage,
    clones: [
      {
        identity: "clone:a",
        tokenHash: "a",
        tokens: 2,
        fragments: [
          { file: "a.ts", startLine: 1, endLine: 1 },
          { file: "b.ts", startLine: 1, endLine: 1 },
        ],
      },
    ],
  };
}
describe("duplication occurrence comparison", () => {
  it("carries baseline debt across an equal threshold only when significant source is unchanged", () => {
    const same = compareCloneOccurrences(
      report(50),
      report(51),
      index("foo bar"),
      index("foo  bar"),
      changes,
      50,
    );
    expect(same.baselineObservations).toHaveLength(2);
    expect(
      same.targetObservations.map((item) => item.comparisonIdentity),
    ).toEqual(same.baselineObservations.map((item) => item.comparisonIdentity));
    const changed = compareCloneOccurrences(
      report(50),
      report(51),
      index("foo bar"),
      index("foo baz"),
      changes,
      50,
    );
    expect(changed.baselineObservations).toHaveLength(0);
    expect(changed.targetObservations).toHaveLength(2);
  });
  it("retains the target threshold gate at equality", () => {
    expect(
      compareCloneOccurrences(
        report(50),
        report(50),
        index("foo bar"),
        index("foo bar"),
        changes,
        50,
      ).targetObservations,
    ).toEqual([]);
  });
});
