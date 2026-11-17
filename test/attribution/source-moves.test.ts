import { describe, expect, it } from "vitest";
import { buildSourceMoveMap } from "../../src/attribution/source-moves.js";
import { collectMetricEntitySpans } from "../../src/attribution/entities.js";
import type { ChangeSet } from "../../src/git/change-set.js";

const debt =
  "export function debt(a) { if (a) return <p>It's debt</p>; return null; }";
function input(
  before: Record<string, string>,
  after: Record<string, string>,
  changes?: ChangeSet["files"],
) {
  const files = (sources: Record<string, string>) =>
    Object.fromEntries(
      Object.entries(sources).map(([file, source]) => [
        file,
        {
          source,
          entities: collectMetricEntitySpans(source, file),
          policyIdentity: "same",
        },
      ]),
    );
  return {
    baseline: files(before),
    target: files(after),
    changes:
      changes ??
      new Map(
        [...new Set([...Object.keys(before), ...Object.keys(after)])].map(
          (path) => [
            path,
            {
              path,
              status: !(path in after)
                ? ("deleted" as const)
                : !(path in before)
                  ? ("added" as const)
                  : ("modified" as const),
              addedRanges: [],
            },
          ],
        ),
      ),
  };
}

describe("captured source moves", () => {
  it("pairs a removed entity with its unique destination across a split", () => {
    const result = buildSourceMoveMap(
      input(
        { "old.jsx": debt + "\nexport const keep = 1;" },
        { "new.jsx": debt, "rest.jsx": "export const keep = 1;" },
      ),
    );
    expect(
      result.pairs.map((pair) => [
        pair.baseline.entity.file,
        pair.target.entity.file,
      ]),
    ).toEqual([["old.jsx", "new.jsx"]]);
  });
  it("accounts for retained occurrences before matching an extracted entity", () => {
    const keep = "export function keep() { return 0; }";
    const result = buildSourceMoveMap(
      input(
        { "old.jsx": debt + "\n" + keep },
        { "old.jsx": keep, "new.jsx": debt },
      ),
    );
    expect(
      result.pairs.filter(
        (pair) => pair.baseline.entity.file !== pair.target.entity.file,
      ),
    ).toHaveLength(1);
  });
  it("does not match a copy when the original remains", () => {
    expect(
      buildSourceMoveMap(
        input({ "old.jsx": debt }, { "old.jsx": debt, "new.jsx": debt }),
      ).pairs.filter((pair) => pair.target.entity.file === "new.jsx"),
    ).toEqual([]);
  });
  it("leaves one removal and two destinations ambiguous", () => {
    const result = buildSourceMoveMap(
      input({ "old.jsx": debt }, { "a.jsx": debt, "b.jsx": debt }),
    );
    expect(result.pairs).toEqual([]);
    expect(result.ambiguous).toHaveLength(1);
  });
  it("does not use unselected baseline files as donors", () => {
    const changes = new Map([
      [
        "new.jsx",
        { path: "new.jsx", status: "added" as const, addedRanges: [] },
      ],
    ]);
    expect(
      buildSourceMoveMap(
        input({ "old.jsx": debt }, { "new.jsx": debt }, changes),
      ).pairs,
    ).toEqual([]);
  });
  it("normalizes ordinary comments and formatting while preserving literal and JSX text", () => {
    const after = debt.replace("if (a)", "/* explanation */ if ( a )");
    expect(
      buildSourceMoveMap(input({ "old.jsx": debt }, { "new.jsx": after }))
        .pairs,
    ).toHaveLength(1);
    for (const changed of [
      debt.replace("It's debt", "It's new debt"),
      debt.replace("return null", "return 'value'"),
    ]) {
      expect(
        buildSourceMoveMap(input({ "old.jsx": debt }, { "new.jsx": changed }))
          .pairs,
      ).toEqual([]);
    }
  });
  it("requires equal effective policy", () => {
    const value = input({ "old.jsx": debt }, { "new.jsx": debt });
    value.target["new.jsx"]!.policyIdentity = "different";
    const result = buildSourceMoveMap(value);
    expect(result.pairs).toEqual([]);
    expect(result.unmatched).toHaveLength(1);
  });
  it("rejects directives and incompatible lexical ownership", () => {
    expect(
      buildSourceMoveMap(
        input({ "old.jsx": debt }, { "new.jsx": "'use client';\n" + debt }),
      ).pairs,
    ).toEqual([]);
    expect(
      buildSourceMoveMap(
        input(
          { "old.jsx": debt },
          { "new.jsx": "// eslint-disable-next-line\n" + debt },
        ),
      ).pairs,
    ).toEqual([]);
    const inner = "function debt(a) { if (a) return a; }";
    expect(
      buildSourceMoveMap(
        input(
          { "old.js": "function outer() { " + inner + " }" },
          { "new.js": inner },
        ),
      ).pairs,
    ).toEqual([]);
  });
  it("reserves rename continuations and marks changed syntax explicitly", () => {
    const changes = new Map([
      [
        "new.jsx",
        {
          path: "new.jsx",
          previousPath: "old.jsx",
          status: "renamed" as const,
          addedRanges: [],
        },
      ],
    ]);
    const result = buildSourceMoveMap(
      input(
        { "old.jsx": debt },
        {
          "new.jsx": debt.replace(
            "return null",
            "if (a > 1) return 1; return null",
          ),
        },
        changes,
      ),
    );
    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]!.syntaxEqual).toBe(false);
  });
  it("falls back without exemptions when its budget is exhausted", () => {
    const result = buildSourceMoveMap({
      ...input({ "old.jsx": debt }, { "new.jsx": debt }),
      limits: { maxBytes: 1 },
    });
    expect(result.pairs).toEqual([]);
    expect(result.diagnostics).toEqual(["SOURCE_MOVE_BUDGET_EXCEEDED"]);
  });
  it("honors cancellation", () => {
    const controller = new AbortController();
    controller.abort();
    expect(() =>
      buildSourceMoveMap({
        ...input({ "old.jsx": debt }, { "new.jsx": debt }),
        signal: controller.signal,
      }),
    ).toThrow();
  });
});

describe("move syntax ownership and accounting", () => {
  it.each([
    [
      "const debt = (a) => { if (a) return a; return 0; };",
      "const debt = (a) => { if (a) return a; return 0; };",
      1,
    ],
    [
      "class A { debt(a) { if (a) return a; } }",
      "class A { debt(a) { if (a) return a; } }",
      1,
    ],
    [
      "class A { debt(a) { if (a) return a; } }",
      "class B { debt(a) { if (a) return a; } }",
      0,
    ],
    [
      "class A { get debt() { return 1; } }",
      "class A { debt() { return 1; } }",
      0,
    ],
    [
      "function debt(a) { if (a) return a; }",
      "export function debt(a) { if (a) return a; }",
      0,
    ],
    [
      "function outer() { return (a) => a ? 1 : 0; }",
      "function outer() { return (a) => a ? 1 : 0; }",
      2,
    ],
  ])("matches only compatible full syntax: %s", (before, after, count) => {
    expect(
      buildSourceMoveMap(input({ "old.ts": before }, { "new.ts": after }))
        .pairs,
    ).toHaveLength(count);
  });
  it("leaves repeated removed baseline declarations ambiguous", () => {
    const result = buildSourceMoveMap(
      input({ "a.jsx": debt, "b.jsx": debt }, { "new.jsx": debt }),
    );
    expect(result.pairs).toHaveLength(0);
    expect(result.ambiguous).toHaveLength(1);
  });
});

it.each([
  { maxFiles: 1 },
  { maxEntities: 1 },
  { maxTokens: 1 },
  { maxMilliseconds: 0 },
])("retains no exemptions after bounded processing stops: %j", (limits) => {
  const result = buildSourceMoveMap({
    ...input({ "old.jsx": debt }, { "new.jsx": debt }),
    limits,
  });
  expect(result.pairs).toEqual([]);
  expect(result.diagnostics).toEqual(["SOURCE_MOVE_BUDGET_EXCEEDED"]);
});

it("does not use policy differences to guess between identical removed donors", () => {
  const value = input({ "a.jsx": debt, "b.jsx": debt }, { "new.jsx": debt });
  value.baseline["b.jsx"]!.policyIdentity = "different";
  expect(buildSourceMoveMap(value).pairs).toEqual([]);
});
