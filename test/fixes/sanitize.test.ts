import { describe, expect, it } from "vitest";
import { sanitizeFixCandidates } from "../../src/fixes/sanitize.js";

const settings = {
  printWidth: 80,
  tabWidth: 2,
  useTabs: false,
  semi: true,
  singleQuote: false,
  quoteProps: "as-needed" as const,
  jsxSingleQuote: false,
  trailingComma: "all" as const,
  bracketSpacing: true,
  bracketSameLine: false,
  arrowParens: "always" as const,
  proseWrap: "preserve" as const,
  endOfLine: "lf" as const,
  singleAttributePerLine: false,
};

function candidateScope(checkId: string, findingIds: readonly string[]) {
  return { checkId, findingIds };
}

describe("sanitizeFixCandidates", () => {
  it("deep-freezes a source-bearing exact candidate without serializing it", () => {
    const [candidate] = sanitizeFixCandidates(
      [
        {
          kind: "exact-file",
          checkId: "lint",
          file: "src/value.ts",
          baseSource: "const value = 1\n",
          edits: [
            {
              findingId: "finding-1",
              severity: "error",
              start: 5,
              end: 10,
              replacement: "answer",
            },
          ],
        },
      ],
      candidateScope("lint", ["finding-1"]),
    );

    expect(candidate).toMatchObject({
      kind: "exact-file",
      file: "src/value.ts",
      baseSource: "const value = 1\n",
    });
    expect(candidate?.kind).toBe("exact-file");
    if (candidate?.kind !== "exact-file") throw new Error("Expected exact fix");
    expect(Object.isFrozen(candidate)).toBe(true);
    expect(Object.isFrozen(candidate.edits)).toBe(true);
    expect(Object.isFrozen(candidate.edits[0])).toBe(true);
  });

  it("sorts exact edits deterministically and deeply freezes format settings", () => {
    const [exactCandidate] = sanitizeFixCandidates(
      [
        {
          kind: "exact-file",
          checkId: "reactCorrectness",
          file: "src/view.tsx",
          baseSource: "const value = 1\n",
          edits: [
            {
              findingId: "later",
              severity: "warning",
              start: 12,
              end: 13,
              replacement: "2",
            },
            {
              findingId: "first",
              severity: "error",
              start: 6,
              end: 11,
              replacement: "answer",
            },
          ],
        },
      ],
      candidateScope("reactCorrectness", ["first", "later"]),
    );
    const [formatCandidate] = sanitizeFixCandidates(
      [
        {
          kind: "format-file",
          checkId: "formatting",
          file: "src/value.ts",
          findingIds: ["formatting-1"],
          severities: ["warning"],
          settings,
        },
      ],
      candidateScope("formatting", ["formatting-1"]),
    );

    expect(exactCandidate).toMatchObject({
      edits: [
        { findingId: "first", start: 6, end: 11 },
        { findingId: "later", start: 12, end: 13 },
      ],
    });
    expect(formatCandidate?.kind).toBe("format-file");
    if (formatCandidate?.kind !== "format-file") {
      throw new Error("Expected format fix");
    }
    expect(Object.isFrozen(formatCandidate.settings)).toBe(true);
    expect(Object.isFrozen(formatCandidate.findingIds)).toBe(true);
  });

  it.each([
    ["an absolute path", { file: "/src/value.ts" }],
    ["a traversal path", { file: "../src/value.ts" }],
    ["an invalid offset", { edits: [{ start: -1 }] }],
    ["an out-of-bounds offset", { edits: [{ end: 99 }] }],
    [
      "overlapping edits",
      {
        edits: [
          {
            findingId: "first",
            severity: "error",
            start: 1,
            end: 5,
            replacement: "one",
          },
          {
            findingId: "second",
            severity: "error",
            start: 4,
            end: 6,
            replacement: "two",
          },
        ],
      },
    ],
    ["an unsupported check ID", { checkId: "types" }],
    [
      "a control character in a finding ID",
      { edits: [{ findingId: "bad\u0000id" }] },
    ],
  ] as const)("rejects %s", (_label, patch) => {
    const candidate = {
      kind: "exact-file" as const,
      checkId: "lint" as const,
      file: "src/value.ts",
      baseSource: "const value = 1\n",
      edits: [
        {
          findingId: "finding-1",
          severity: "error" as const,
          start: 6,
          end: 11,
          replacement: "answer",
        },
      ],
      ...patch,
    };
    const editPatch = patch as {
      readonly edits?: readonly Partial<(typeof candidate.edits)[number]>[];
    };
    if (editPatch.edits !== undefined) {
      candidate.edits = editPatch.edits.map((edit) => ({
        findingId: "finding-1",
        severity: "error" as const,
        start: 6,
        end: 11,
        replacement: "answer",
        ...edit,
      }));
    }

    expect(() =>
      sanitizeFixCandidates(
        [candidate],
        candidateScope("lint", ["finding-1", "first", "second"]),
      ),
    ).toThrow(TypeError);
  });

  it("rejects format candidates with mismatched finding IDs and severities", () => {
    expect(() =>
      sanitizeFixCandidates(
        [
          {
            kind: "format-file",
            checkId: "formatting",
            file: "src/value.ts",
            findingIds: ["formatting-1"],
            severities: [],
            settings,
          },
        ],
        candidateScope("formatting", ["formatting-1"]),
      ),
    ).toThrow(TypeError);
  });

  it("rejects candidates that do not belong to the dispatched check", () => {
    expect(() =>
      sanitizeFixCandidates(
        [
          {
            kind: "format-file",
            checkId: "formatting",
            file: "src/value.ts",
            findingIds: ["staged-format"],
            severities: ["warning"],
            settings,
          },
        ],
        candidateScope("lint", ["staged-format"]),
      ),
    ).toThrow(TypeError);
  });

  it("rejects exact and format candidates that reference findings outside the policy result", () => {
    expect(() =>
      sanitizeFixCandidates(
        [
          {
            kind: "exact-file",
            checkId: "lint",
            file: "src/value.ts",
            baseSource: "const value = 1\n",
            edits: [
              {
                findingId: "unknown-exact",
                severity: "error",
                start: 6,
                end: 11,
                replacement: "answer",
              },
            ],
          },
        ],
        candidateScope("lint", ["staged-exact"]),
      ),
    ).toThrow(TypeError);
    expect(() =>
      sanitizeFixCandidates(
        [
          {
            kind: "format-file",
            checkId: "formatting",
            file: "src/value.ts",
            findingIds: ["unknown-format"],
            severities: ["warning"],
            settings,
          },
        ],
        candidateScope("formatting", ["staged-format"]),
      ),
    ).toThrow(TypeError);
  });

  it("rejects inherited and getter-backed candidate properties", () => {
    const inherited = Object.create({
      kind: "exact-file",
      checkId: "lint",
      file: "src/value.ts",
      baseSource: "const value = 1\n",
      edits: [],
    });
    const getterBacked = {
      kind: "exact-file",
      checkId: "lint",
      file: "src/value.ts",
      get baseSource() {
        return "const value = 1\n";
      },
      edits: [],
    };

    expect(() =>
      sanitizeFixCandidates([inherited], candidateScope("lint", [])),
    ).toThrow(TypeError);
    expect(() =>
      sanitizeFixCandidates([getterBacked], candidateScope("lint", [])),
    ).toThrow(TypeError);
  });
});
