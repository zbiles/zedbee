import { expect, it } from "vitest";
import { pairLocationObservations } from "../../src/attribution/pair-locations.js";
import { compareObservationSets } from "../../src/attribution/compare.js";
import type { Observation } from "../../src/core/types.js";
const observation = (endLine: number, startLine = 1): Observation => ({
  check: "reactAccessibility",
  rule: "jsx-a11y/no-noninteractive-element-interactions",
  identity: `element:${startLine}:${endLine}`,
  severity: "error",
  message:
    "Non-interactive elements should not be assigned mouse or keyboard event listeners.",
  location: {
    file: "app.tsx",
    startLine,
    startColumn: 1,
    endLine,
    endColumn: 3,
  },
});
it("pairs a baseline JSX finding when only its inline handler range grows", () => {
  const changeSet = {
    files: new Map(),
    isEmpty: false,
    containsAddedLine: () => true,
  };
  const paired = pairLocationObservations(
    {
      observations: [observation(3)],
      files: { "app.tsx": '<div role="article"\n onKeyDown={()=>{}}\n/>' },
    },
    {
      observations: [observation(5)],
      files: {
        "app.tsx": '<div role="article"\n onKeyDown={()=>{\n return;\n }}\n/>',
      },
    },
    changeSet,
  );
  const result = compareObservationSets(
    paired.baselineObservations,
    paired.targetObservations,
    {
      changedPaths: ["app.tsx"],
      changedEntityIdentities: [],
      repositoryDelta: false,
      addedRanges: [{ file: "app.tsx", start: 2, end: 4 }],
    },
  );
  expect(result[0]?.attribution.staged).toBe(false);
});
it("does not suppress a second newly added occurrence", () => {
  const paired = pairLocationObservations(
    {
      observations: [observation(3)],
      files: { "app.tsx": "<div\n onKeyDown={()=>{}}\n/>" },
    },
    {
      observations: [observation(3), observation(6, 4)],
      files: {
        "app.tsx":
          "<div\n onKeyDown={()=>{}}\n/>\n<div\n onKeyDown={()=>{}}\n/>",
      },
    },
    { files: new Map(), isEmpty: false, containsAddedLine: () => true },
  );
  const result = compareObservationSets(
    paired.baselineObservations,
    paired.targetObservations,
    {
      changedPaths: ["app.tsx"],
      changedEntityIdentities: [],
      repositoryDelta: false,
      addedRanges: [{ file: "app.tsx", start: 4, end: 6 }],
    },
  );
  expect(result.filter((f) => f.attribution.staged)).toHaveLength(1);
});
it("does not pair a replacement element merely at the old coordinates", () => {
  const paired = pairLocationObservations(
    {
      observations: [observation(3)],
      files: { "app.tsx": '<div role="article"\n onKeyDown={()=>{}}\n/>' },
    },
    {
      observations: [observation(5)],
      files: {
        "app.tsx":
          '<section role="article"\n onClick={()=>{\n alert("new");\n }}\n/>',
      },
    },
    { files: new Map(), isEmpty: false, containsAddedLine: () => true },
  );
  const result = compareObservationSets(
    paired.baselineObservations,
    paired.targetObservations,
    {
      changedPaths: ["app.tsx"],
      changedEntityIdentities: [],
      repositoryDelta: false,
      addedRanges: [{ file: "app.tsx", start: 1, end: 5 }],
    },
  );
  expect(result[0]?.attribution.staged).toBe(true);
});
