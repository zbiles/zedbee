import { expect, it } from "vitest";
import { pairSourceMoveLocations } from "../../src/attribution/pair-source-moves.js";
import { collectMetricEntitySpans } from "../../src/attribution/entities.js";
import { buildSourceMoveMap } from "../../src/attribution/source-moves.js";
import type { Observation } from "../../src/core/types.js";

it("preserves existing top-level JSX debt while requiring the same raw problem", () => {
  const observation: Observation = {
    check: "reactCorrectness",
    rule: "react/no-unescaped-entities",
    identity: "diagnostic",
    severity: "error",
    message: "redacted",
    comparisonIdentity: "apostrophe",
    location: { file: "file.jsx", startLine: 1, startColumn: 12 },
  };
  const moves = { pairs: [], ambiguous: [], unmatched: [], diagnostics: [] };
  const paired = pairSourceMoveLocations([observation], [observation], moves, {
    baseline: {},
    target: {},
  });
  expect(paired.baselineObservations[0]!.comparisonIdentity).toBe(
    paired.targetObservations[0]!.comparisonIdentity,
  );
  const changed = pairSourceMoveLocations(
    [observation],
    [{ ...observation, comparisonIdentity: "quotation" }],
    moves,
    { baseline: {}, target: {} },
  );
  expect(changed.baselineObservations[0]!.comparisonIdentity).not.toBe(
    changed.targetObservations[0]!.comparisonIdentity,
  );
});
it("maps the exact JSX token offset across a formatting edit without exposing source", () => {
  const before = "export function Debt() { return <p>It's debt</p>; }";
  const after =
    "export function Debt() {\n  // explanation\n  return <p>It's debt</p>;\n}";
  const moves = buildSourceMoveMap({
    baseline: {
      "old.jsx": {
        source: before,
        entities: collectMetricEntitySpans(before, "old.jsx"),
        policyIdentity: "same",
      },
    },
    target: {
      "new.jsx": {
        source: after,
        entities: collectMetricEntitySpans(after, "new.jsx"),
        policyIdentity: "same",
      },
    },
    changes: new Map([
      ["old.jsx", { path: "old.jsx", status: "deleted", addedRanges: [] }],
      ["new.jsx", { path: "new.jsx", status: "added", addedRanges: [] }],
    ]),
  });
  const observation: Observation = {
    check: "reactCorrectness",
    rule: "react/no-unescaped-entities",
    identity: "diagnostic",
    severity: "error",
    message: "redacted",
    comparisonIdentity: "apostrophe",
    location: {
      file: "old.jsx",
      startLine: 1,
      startColumn: before.indexOf("'") + 1,
    },
  };
  const target = {
    ...observation,
    location: {
      file: "new.jsx",
      startLine: 3,
      startColumn: after.split("\n")[2]!.indexOf("'") + 1,
    },
  };
  const paired = pairSourceMoveLocations([observation], [target], moves, {
    baseline: { "old.jsx": before },
    target: { "new.jsx": after },
  });
  expect(paired.baselineObservations[0]!.comparisonIdentity).toBe(
    paired.targetObservations[0]!.comparisonIdentity,
  );
});
