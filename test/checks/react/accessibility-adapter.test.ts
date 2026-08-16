import { describe, expect, it } from "vitest";
import type {
  CheckRunContext,
  InspectionContext,
} from "../../../src/checks/adapter.js";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import { reactAccessibilityAdapter } from "../../../src/checks/react/accessibility-adapter.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet, ChangedFile } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";

async function accessibilityContext(dependencies: Record<string, string>) {
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  for (const fixture of [baseline, staged, live]) {
    await fixture.writeJson("package.json", {
      name: "fixture",
      private: true,
      dependencies,
    });
    await fixture.write("src/app.tsx", "export const App = () => <main />;\n");
  }
  await staged.write(
    "src/app.tsx",
    [
      "export function App() {",
      '  return <><img src="logo.png" /><div onClick={() => undefined}>Open</div></>;',
      "}",
      "",
    ].join("\n"),
  );
  const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
  const changedFiles = new Map<string, ChangedFile>([
    [
      "src/app.tsx",
      {
        path: "src/app.tsx",
        status: "modified",
        addedRanges: [{ start: 1, end: 3 }],
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
  const inspection = {
    repositoryRoot: live.root,
    changeSet,
    config,
    baselineInspection: await inspectRepository(baseline.root),
    targetInspection: await inspectRepository(staged.root),
  } satisfies InspectionContext;
  return {
    fixtures: { baseline, staged, live },
    changedFiles,
    inspection,
    run: {
      ...inspection,
      snapshots: {
        baselineDir: baseline.root,
        targetDir: staged.root,
        baselineRef: "HEAD",
        unsupportedEntries: [],
      },
      target: { id: ".", kind: "workspace", relativeRoot: "." },
      policy: config.checks.reactAccessibility,
      signal: new AbortController().signal,
    } satisfies CheckRunContext,
  };
}

describe("reactAccessibilityAdapter", () => {
  it("finds missing accessible labels and click-only interaction in React DOM", async () => {
    const { run } = await accessibilityContext({
      react: "19.0.0",
      "react-dom": "19.0.0",
    });

    await expect(reactAccessibilityAdapter.inspect(run)).resolves.toMatchObject(
      {
        applies: true,
        requiresBaseline: true,
        targets: [{ id: ".", kind: "workspace", relativeRoot: "." }],
      },
    );
    const result = await reactAccessibilityAdapter.collect(run);

    expect(result.targetObservations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ rule: "jsx-a11y/alt-text" }),
        expect.objectContaining({
          rule: "jsx-a11y/click-events-have-key-events",
        }),
      ]),
    );
  });

  it.each([
    ["Next", { react: "19.0.0", next: "16.0.0" }],
    ["Remix", { react: "19.0.0", "@remix-run/react": "2.0.0" }],
  ])(
    "finds DOM accessibility findings in a %s workspace",
    async (_name, dependencies) => {
      const { run } = await accessibilityContext(dependencies);

      await expect(
        reactAccessibilityAdapter.inspect(run),
      ).resolves.toMatchObject({
        applies: true,
        targets: [{ id: ".", kind: "workspace", relativeRoot: "." }],
      });
      const result = await reactAccessibilityAdapter.collect(run);

      expect(result.targetObservations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ rule: "jsx-a11y/alt-text" }),
          expect.objectContaining({
            rule: "jsx-a11y/click-events-have-key-events",
          }),
        ]),
      );
    },
  );

  it("skips Ink-only workspaces with the exact DOM-renderer reason", async () => {
    const { inspection } = await accessibilityContext({
      react: "19.0.0",
      ink: "7.0.0",
    });

    await expect(
      reactAccessibilityAdapter.inspect(inspection),
    ).resolves.toEqual({
      applies: false,
      reason: "No browser DOM renderer detected",
    });
  });

  it("does not infer a browser DOM renderer from JSX syntax alone", async () => {
    const { inspection } = await accessibilityContext({});

    await expect(
      reactAccessibilityAdapter.inspect(inspection),
    ).resolves.toEqual({
      applies: false,
      reason: "No browser DOM renderer detected",
    });
  });

  it("attributes only changed-line accessibility debt and reads the staged snapshot", async () => {
    const { fixtures, changedFiles, run } = await accessibilityContext({
      react: "19.0.0",
      "react-dom": "19.0.0",
    });
    await fixtures.baseline.write(
      "src/app.tsx",
      'export const App = () => <><img src="old.png" /></>;\n',
    );
    await fixtures.staged.write(
      "src/app.tsx",
      [
        'export const App = () => <><img src="old.png" />',
        '<img src="new.png" /></>;',
        "",
      ].join("\n"),
    );
    await fixtures.live.write(
      "src/app.tsx",
      'export const App = () => <img src="fixed.png" alt="Logo" />;\n',
    );
    changedFiles.set("src/app.tsx", {
      path: "src/app.tsx",
      status: "modified",
      addedRanges: [{ start: 2, end: 2 }],
    });

    const collected = await reactAccessibilityAdapter.collect(run);
    const result = await observationCheckResult(
      "reactAccessibility",
      collected,
      run,
      true,
    );

    expect(
      result.findings
        .filter(({ rule }) => rule === "jsx-a11y/alt-text")
        .map(({ attribution, location }) => ({
          staged: attribution.staged,
          line: location?.startLine,
        })),
    ).toEqual([
      { staged: false, line: 1 },
      { staged: true, line: 2 },
    ]);
  });
});
