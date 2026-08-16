import { access } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckRunContext } from "../../../src/checks/adapter.js";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import { reactCorrectnessAdapter } from "../../../src/checks/react/correctness-adapter.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet, ChangedFile } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";

async function reactContext(
  environment: "react" | "ink",
  options: {
    readonly filePath?: string;
    readonly cleanSource?: string;
    readonly stagedSource?: string;
  } = {},
) {
  const filePath = options.filePath ?? "src/app.tsx";
  const cleanSource =
    options.cleanSource ?? "export const App = () => <main />;\n";
  const stagedSource =
    options.stagedSource ??
    [
      'import { useState } from "react";',
      "export function App({ ready }: { ready: boolean }) {",
      "  if (ready) useState(0);",
      "  return [1, 2].map(value => <span>{value}</span>);",
      "}",
      "",
    ].join("\n");
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, staged, live]) {
    await fixture.writeJson("package.json", {
      name: "fixture",
      private: true,
      dependencies:
        environment === "ink"
          ? { react: "19.0.0", ink: "7.0.0" }
          : { react: "19.0.0", "react-dom": "19.0.0" },
    });
    await fixture.write(filePath, cleanSource);
  }
  await staged.write(filePath, stagedSource);
  const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
  const changedFiles = new Map<string, ChangedFile>([
    [
      filePath,
      {
        path: filePath,
        status: "modified",
        addedRanges: [{ start: 1, end: 5 }],
      },
    ],
  ]);
  const changeSet: ChangeSet = {
    files: changedFiles,
    isEmpty: false,
    containsAddedLine(file, line) {
      return (
        changedFiles
          .get(file)
          ?.addedRanges.some(
            ({ start, end }) => line >= start && line <= end,
          ) ?? false
      );
    },
  };
  return {
    fixtures: { baseline, staged, live },
    changedFiles,
    run: {
      repositoryRoot: live.root,
      changeSet,
      config,
      snapshots: {
        baselineDir: baseline.root,
        targetDir: staged.root,
        baselineRef: "HEAD",
        unsupportedEntries: [],
      },
      baselineInspection: await inspectRepository(baseline.root),
      targetInspection: await inspectRepository(staged.root),
      target: { id: ".", kind: "workspace", relativeRoot: "." },
      policy: config.checks.reactCorrectness,
      signal: new AbortController().signal,
    } satisfies CheckRunContext,
  };
}

describe("reactCorrectnessAdapter", () => {
  it.each(["react", "ink"] as const)(
    "finds Rules of Hooks and missing-key violations in a %s workspace",
    async (environment) => {
      const { run } = await reactContext(environment);

      await expect(reactCorrectnessAdapter.inspect(run)).resolves.toMatchObject(
        {
          applies: true,
          requiresBaseline: true,
          targets: [{ id: ".", kind: "workspace", relativeRoot: "." }],
        },
      );
      const result = await reactCorrectnessAdapter.collect(run);

      expect(result.targetObservations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "react-hooks/rules-of-hooks" }),
          expect.objectContaining({ rule: "react/jsx-key" }),
        ]),
      );
    },
  );

  it.each(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"])(
    "parses managed .%s source without project configuration",
    async (extension) => {
      const filePath = `src/app.${extension}`;
      const { run } = await reactContext("react", {
        filePath,
        cleanSource: "export function App() { return null; }\n",
        stagedSource:
          "export function App(ready) { if (ready) useState(0); return null; }\n",
      });

      const result = await reactCorrectnessAdapter.collect(run);

      expect(result.targetObservations).toContainEqual(
        expect.objectContaining({
          rule: "react-hooks/rules-of-hooks",
          location: expect.objectContaining({ file: filePath }),
        }),
      );
    },
  );

  it("returns a parsing observation instead of an empty success for malformed JSX", async () => {
    const { fixtures, run } = await reactContext("react");
    await fixtures.staged.write(
      "src/app.tsx",
      "export const App = () => <main>;\n",
    );

    const result = await reactCorrectnessAdapter.collect(run);

    expect(result.targetObservations).toContainEqual(
      expect.objectContaining({
        check: "reactCorrectness",
        rule: "eslint/parsing-error",
        location: expect.objectContaining({ file: "src/app.tsx" }),
      }),
    );
  });

  it("attributes only the new changed-line finding and ignores clean live code", async () => {
    const { fixtures, changedFiles, run } = await reactContext("react");
    const existing = [
      "export function Existing({ ready }: { ready: boolean }) {",
      "  if (ready) React.useState(0);",
      "  return null;",
      "}",
      "",
    ].join("\n");
    await fixtures.baseline.write("src/app.tsx", existing);
    await fixtures.staged.write(
      "src/app.tsx",
      [
        existing.trimEnd(),
        "export function Added({ ready }: { ready: boolean }) {",
        "  if (ready) React.useState(0);",
        "  return null;",
        "}",
        "",
      ].join("\n"),
    );
    await fixtures.live.write(
      "src/app.tsx",
      "export function Added() { return null; }\n",
    );
    changedFiles.set("src/app.tsx", {
      path: "src/app.tsx",
      status: "modified",
      addedRanges: [{ start: 5, end: 8 }],
    });

    const collected = await reactCorrectnessAdapter.collect(run);
    const result = await observationCheckResult(
      "reactCorrectness",
      collected,
      run,
      true,
    );

    expect(
      result.findings
        .filter(({ rule }) => rule === "react-hooks/rules-of-hooks")
        .map(({ attribution, location }) => ({
          staged: attribution.staged,
          line: location?.startLine,
        })),
    ).toEqual([
      { staged: false, line: 2 },
      { staged: true, line: 6 },
    ]);
  });

  it("never executes project ESLint config and emits only normalized observations", async () => {
    const { fixtures, run } = await reactContext("react");
    await fixtures.staged.write(
      "eslint.config.mjs",
      [
        'import { writeFileSync } from "node:fs";',
        'writeFileSync("CONFIG_EXECUTED", "yes");',
        "export default [];",
        "",
      ].join("\n"),
    );

    const collected = await reactCorrectnessAdapter.collect(run);
    const serialized = JSON.stringify(collected);

    await expect(
      access(join(fixtures.staged.root, "CONFIG_EXECUTED")),
    ).rejects.toThrow();
    expect(serialized).not.toContain(fixtures.staged.root);
    expect(serialized).not.toContain(fixtures.live.root);
    expect(serialized).not.toContain("useState } from");
    expect(serialized).not.toContain('"fix"');
    expect(serialized).not.toContain('"suggestions"');
  });
});
