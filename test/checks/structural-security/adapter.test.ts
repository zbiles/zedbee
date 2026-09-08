import { unlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CheckRunContext } from "../../../src/checks/adapter.js";
import { observationCheckResult } from "../../../src/checks/observation-result.js";
import { structuralSecurityAdapter } from "../../../src/checks/structural-security/adapter.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ChangeSet, ChangedFile } from "../../../src/git/change-set.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

async function structuralSecurityContext() {
  const [baseline, staged, live] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  const safe = "export const existing = eval(existingInput);\n";
  for (const fixture of [baseline, staged, live]) {
    await fixture.writeJson("package.json", { name: "fixture", private: true });
    await fixture.write("src/security.ts", safe);
    await fixture.write(
      "src/untouched.ts",
      "export const untouched = eval(untouchedInput);\n",
    );
  }
  await staged.write(
    "src/security.ts",
    `${safe}export const added = eval(stagedInput);\n`,
  );
  // The live tree is deliberately safer than the exact staged snapshot.
  await live.write("src/security.ts", "export const added = 1;\n");

  const changedFile: ChangedFile = {
    path: "src/security.ts",
    status: "modified",
    addedRanges: [{ start: 2, end: 2 }],
  };
  const changeSet: ChangeSet = {
    files: new Map([[changedFile.path, changedFile]]),
    isEmpty: false,
    containsAddedLine(file, line) {
      return file === changedFile.path && line === 2;
    },
  };
  const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });
  return {
    fixtures: { baseline, staged, live },
    run: {
      repositoryRoot: live.root,
      changeSet,
      config,
      snapshots: {
        baselineDir: baseline.root,
        targetDir: staged.root,
        baselineRef: "HEAD",
        targetRef: "index",
        unsupportedEntries: [],
      },
      baselineInspection: await inspectRepository(baseline.root),
      targetInspection: await inspectRepository(staged.root),
      target: { id: ".", kind: "workspace", relativeRoot: "." },
      policy: config.checks.structuralSecurity,
      policyForFile: testFilePolicyResolver(config),
      signal: new AbortController().signal,
    } satisfies CheckRunContext,
  };
}

describe("structuralSecurityAdapter", () => {
  it("analyzes exact baseline and staged snapshots and attributes only a new changed range", async () => {
    const { run } = await structuralSecurityContext();

    await expect(structuralSecurityAdapter.inspect(run)).resolves.toMatchObject(
      {
        applies: true,
        executionClass: "lightweight",
        requiresBaseline: true,
        targets: [{ id: ".", kind: "workspace", relativeRoot: "." }],
      },
    );
    const collected = await structuralSecurityAdapter.collect(run);
    const result = await observationCheckResult(
      "structuralSecurity",
      collected,
      run,
      true,
    );

    expect(collected.targetObservations).toHaveLength(3);
    expect(
      result.findings
        .filter(({ attribution }) => attribution.staged)
        .map(({ attribution, location, rule }) => ({
          staged: attribution.staged,
          file: location?.file,
          line: location?.startLine,
          rule,
        })),
    ).toEqual([
      {
        staged: true,
        file: "src/security.ts",
        line: 2,
        rule: "direct-eval",
      },
    ]);
    expect(
      result.findings
        .filter(({ attribution }) => !attribution.staged)
        .map(({ location }) => `${location?.file}:${location?.startLine}`),
    ).toEqual(["src/security.ts:1", "src/untouched.ts:1"]);
  });

  it("fails closed when an inspected snapshot does not match the supplied inspection", async () => {
    const { fixtures, run } = await structuralSecurityContext();
    const mismatched = await inspectRepository(fixtures.live.root);

    await expect(
      structuralSecurityAdapter.collect({
        ...run,
        targetInspection: mismatched,
      }),
    ).rejects.toThrow("Structural security analysis failed.");
  });

  it("fails closed when a source path is swapped after inspection", async () => {
    const { fixtures, run } = await structuralSecurityContext();
    const sourcePath = join(fixtures.staged.root, "src/security.ts");
    await unlink(sourcePath);
    await symlink(join(fixtures.live.root, "src/security.ts"), sourcePath);

    await expect(structuralSecurityAdapter.collect(run)).rejects.toThrow(
      "Structural security analysis failed.",
    );
  });

  it("identifies the staged file that the managed parser cannot read", async () => {
    const { fixtures, run } = await structuralSecurityContext();
    await fixtures.staged.write(
      "src/security.ts",
      "export const broken = &;\n",
    );

    await expect(structuralSecurityAdapter.collect(run)).rejects.toMatchObject({
      name: "CheckIncompleteError",
      code: "STRUCTURAL_SECURITY_PARSE_FAILED",
      message: "Structural security could not parse a staged source file.",
      path: "src/security.ts",
      remediation:
        "Verify that this file uses valid JavaScript or TypeScript syntax, then retry. If the project accepts this syntax, report a Zedbee parser compatibility issue.",
    });
  });

  it("analyzes valid import-type syntax while retaining structural rule coverage", async () => {
    const { fixtures, run } = await structuralSecurityContext();
    const source = [
      "declare const importOriginal: <T>() => T;",
      'const actual = await importOriginal<typeof import("node:fs")>();',
      "export const insecure = (input: string) => eval(input);",
      "void actual;",
      "",
    ].join("\n");
    for (const fixture of [fixtures.baseline, fixtures.staged]) {
      await fixture.write("src/security.ts", source);
    }
    const context = {
      ...run,
      baselineInspection: await inspectRepository(fixtures.baseline.root),
      targetInspection: await inspectRepository(fixtures.staged.root),
    };

    const collected = await structuralSecurityAdapter.collect(context);

    expect(collected.targetObservations).toContainEqual(
      expect.objectContaining({
        rule: "direct-eval",
        location: expect.objectContaining({
          file: "src/security.ts",
          startLine: 3,
        }),
      }),
    );
  });

  it("preserves exact coordinates across astral Unicode and nested import types", async () => {
    const { fixtures, run } = await structuralSecurityContext();
    const source =
      'declare const f: <T>() => T; const x = await f<typeof import("./😀").Factory<typeof import("./nested").Value>>(); eval(input);';
    for (const fixture of [fixtures.baseline, fixtures.staged]) {
      await fixture.write("src/security.ts", source);
    }
    const context = {
      ...run,
      baselineInspection: await inspectRepository(fixtures.baseline.root),
      targetInspection: await inspectRepository(fixtures.staged.root),
    };

    const collected = await structuralSecurityAdapter.collect(context);

    expect(collected.targetObservations).toContainEqual(
      expect.objectContaining({
        rule: "direct-eval",
        identity: "direct-eval:src/security.ts:1:115:1:126",
        location: {
          file: "src/security.ts",
          startLine: 1,
          startColumn: 115,
          endLine: 1,
          endColumn: 126,
        },
      }),
    );
  });
});
