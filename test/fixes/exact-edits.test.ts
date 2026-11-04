import { describe, expect, it, vi } from "vitest";
import { diffChars } from "diff";
import {
  composeExactFixes,
  createExactEditMapping,
  exactFixesOverlap,
  overlappingExactEdits,
} from "../../src/fixes/exact-edits.js";
import { planCandidates } from "../../src/fixes/plan-candidates.js";
import type { ExactFixEdit } from "../../src/fixes/types.js";

vi.mock("diff", async (actual) => {
  const module = await actual<typeof import("diff")>();
  return { ...module, diffChars: vi.fn(module.diffChars) };
});

const edit = (start: number, end: number): ExactFixEdit => ({
  start,
  end,
  replacement: "FIX",
  findingId: `${start}:${end}`,
  severity: "error",
});

describe("per-file exact-edit mapping", () => {
  it("preserves insertions and working changes at range boundaries", () => {
    expect(composeExactFixes("abc", "aXbc", [edit(1, 2)])).toBe("aXFIXc");
    expect(composeExactFixes("abc", "abXc", [edit(1, 2)])).toBe("aFIXXc");
    expect(composeExactFixes("abc", "aXbc", [edit(1, 1)])).toBeUndefined();
    expect(composeExactFixes("abcd", "ad", [edit(1, 1)])).toBeUndefined();
    expect(composeExactFixes("abcd", "ad", [edit(3, 3)])).toBeUndefined();
    expect(composeExactFixes("abc", "abc", [edit(3, 3)])).toBe("abcFIX");
    expect(composeExactFixes("", "", [edit(0, 0)])).toBe("FIX");
    expect(composeExactFixes("a😀b", "Xa😀b", [edit(1, 3)])).toBe("XaFIXb");
  });

  it("uses one diff for a thousand exact edits and preserves partial skips", () => {
    const base = "abcdefghij".repeat(10_000);
    const edits = Array.from({ length: 1_000 }, (_, index) =>
      edit(index * 100 + 1, index * 100 + 2),
    );
    vi.mocked(diffChars).mockClear();
    const planned = planCandidates(
      [
        {
          kind: "exact-file",
          checkId: "lint",
          file: "a.ts",
          baseSource: base,
          edits,
        },
      ],
      new Map([
        [
          "a.ts",
          {
            path: "a.ts",
            content: `X${base.slice(1)}`,
            sha256: "unused",
            mode: 0o644,
            hasUnstagedChanges: true,
          },
        ],
      ]),
    );
    expect(diffChars).toHaveBeenCalledTimes(1);
    expect(
      planned.candidates[0]?.kind === "exact-file" &&
        planned.candidates[0].edits,
    ).toHaveLength(1_000);
    const partial = planCandidates(
      [
        {
          kind: "exact-file",
          checkId: "lint",
          file: "a.ts",
          baseSource: "abcdef",
          edits: [edit(1, 2), edit(4, 5)],
        },
      ],
      new Map([
        [
          "a.ts",
          {
            path: "a.ts",
            content: "aXcdef",
            sha256: "unused",
            mode: 0o644,
            hasUnstagedChanges: true,
          },
        ],
      ]),
    );
    expect(partial.items.map((item) => [item.status, item.fixes])).toEqual([
      ["skipped", 1],
      ["applicable", 1],
    ]);
  });

  it("reports exhausted mapping as a skip without inventing a working conflict", () => {
    vi.mocked(diffChars).mockReturnValueOnce(undefined as never);
    const planned = planCandidates(
      [
        {
          kind: "exact-file",
          checkId: "lint",
          file: "a.ts",
          baseSource: "abc",
          edits: [edit(1, 2)],
        },
      ],
      new Map([
        [
          "a.ts",
          {
            path: "a.ts",
            content: "xyz",
            sha256: "unused",
            mode: 0o644,
            hasUnstagedChanges: true,
          },
        ],
      ]),
    );
    expect(planned.candidates).toHaveLength(0);
    expect(planned.items[0]).toMatchObject({
      status: "skipped",
      reason:
        "Managed exact fixes could not be mapped within the preview time limit.",
    });
  });

  it("matches pairwise overlap semantics across all interval and insertion combinations", () => {
    const edits: ExactFixEdit[] = [];
    for (let start = 0; start < 20; start++)
      for (let end = start; end <= 20; end++) edits.push(edit(start, end));
    // Several differently ordered subsets exercise nesting, touching, duplicate and interior insertions.
    for (let seed = 0; seed < 30; seed++) {
      const sample = edits
        .filter((_, index) => (index * 17 + seed) % 11 === 0)
        .reverse();
      sample.push(edit(seed % 10, seed % 10), edit(seed % 10, seed % 10));
      const expected = new Set(
        sample.filter((left, index) =>
          sample.some(
            (right, other) => index !== other && exactFixesOverlap(left, right),
          ),
        ),
      );
      expect(overlappingExactEdits(sample)).toEqual(expected);
    }
  });

  it("queries reused mappings without allocating source-length offset arrays", () => {
    const mapping = createExactEditMapping(
      "a".repeat(100_000),
      `X${"a".repeat(100_000)}`,
    )!;
    for (let position = 1; position < 100_000; position += 100)
      expect(mapping.mapEdit(edit(position, position + 1))).toEqual({
        start: position + 1,
        end: position + 2,
      });
  });
});
