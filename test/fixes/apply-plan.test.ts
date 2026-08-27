import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { diffChars } from "diff";
import { describe, expect, it } from "vitest";
import { applyFixPlan } from "../../src/fixes/apply-plan.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../src/checks/prettier/settings.js";
import type { PreparedFixPlan } from "../../src/fixes/types.js";
import { writeWorkingFile } from "../../src/fixes/write-working-file.js";
import { createInspectionFixture } from "../inspection/fixture.js";

function digest(source: string): string {
  return createHash("sha256").update(source, "utf8").digest("hex");
}

function prepared(
  root: string,
  file: string,
  baseSource: string,
  workingSource: string,
  candidates: PreparedFixPlan["candidates"],
): PreparedFixPlan {
  return {
    repositoryRoot: root,
    candidates,
    temporaryReportMaxAgeMs: 60_000,
    publicPlan: {
      schemaVersion: 1,
      target: "index",
      selectedChecks: ["lint"],
      exitCode: 0,
      summary: { fixes: 1, files: 1, blocking: 1, warnings: 0, skipped: 0 },
      files: [{ path: file, fixes: 1, hasUnstagedChanges: true }],
      items: [],
    },
    workingFiles: new Map([
      [
        file,
        {
          path: file,
          sha256: digest(workingSource),
          content: workingSource,
          mode: 0o644,
          hasUnstagedChanges: true,
        },
      ],
    ]),
  };
}

describe("applyFixPlan", () => {
  it("maps exact edits across unrelated working changes without searching repeated text", async () => {
    const fixture = await createInspectionFixture();
    const base = "const target = target;\n";
    const working = "// before\nconst target = target;\n// after\n";
    const changes = diffChars(base, working);
    expect(
      changes.filter((change) => change.added).map((change) => change.value),
    ).toEqual(["// before\n", "// after\n"]);
    await fixture.write("src/value.ts", working);

    const result = await applyFixPlan(
      prepared(fixture.root, "src/value.ts", base, working, [
        {
          kind: "exact-file",
          checkId: "lint",
          file: "src/value.ts",
          baseSource: base,
          edits: [
            {
              findingId: "one",
              severity: "error",
              start: 6,
              end: 12,
              replacement: "answer",
            },
          ],
        },
      ]),
    );

    expect(await readFile(join(fixture.root, "src/value.ts"), "utf8")).toBe(
      "// before\nconst answer = target;\n// after\n",
    );
    expect(result).toMatchObject({
      exitCode: 0,
      appliedFixes: 1,
      changedFiles: ["src/value.ts"],
    });
    expect(Object.isFrozen(result)).toBe(true);
  });

  it("skips an exact range changed in the working file", async () => {
    const fixture = await createInspectionFixture();
    const base = "const target = 1;\n";
    const working = "const custom = 1;\n";
    await fixture.write("src/value.ts", working);

    const result = await applyFixPlan(
      prepared(fixture.root, "src/value.ts", base, working, [
        {
          kind: "exact-file",
          checkId: "lint",
          file: "src/value.ts",
          baseSource: base,
          edits: [
            {
              findingId: "one",
              severity: "error",
              start: 6,
              end: 12,
              replacement: "answer",
            },
          ],
        },
      ]),
    );

    expect(await readFile(join(fixture.root, "src/value.ts"), "utf8")).toBe(
      working,
    );
    expect(result.issues).toEqual([
      expect.objectContaining({ kind: "conflict", file: "src/value.ts" }),
    ]);
  });

  it("combines non-overlapping candidates from one staged source", async () => {
    const fixture = await createInspectionFixture();
    const source = "const one = 1;;\nconst two = 2;;\n";
    await fixture.write("src/value.ts", source);
    const result = await applyFixPlan(
      prepared(fixture.root, "src/value.ts", source, source, [
        {
          kind: "exact-file",
          checkId: "lint",
          file: "src/value.ts",
          baseSource: source,
          edits: [
            {
              findingId: "one",
              severity: "error",
              start: 14,
              end: 15,
              replacement: "",
            },
          ],
        },
        {
          kind: "exact-file",
          checkId: "reactCorrectness",
          file: "src/value.ts",
          baseSource: source,
          edits: [
            {
              findingId: "two",
              severity: "warning",
              start: 30,
              end: 31,
              replacement: "",
            },
          ],
        },
      ]),
    );
    expect(await readFile(join(fixture.root, "src/value.ts"), "utf8")).toBe(
      "const one = 1;\nconst two = 2;\n",
    );
    expect(result.appliedFixes).toBe(2);
  });

  it("formats the complete current working file only when formatting was selected", async () => {
    const fixture = await createInspectionFixture();
    const source = "const value=1;;\nconst unstaged={value:2}\n";
    await fixture.write("src/value.ts", source);
    const exact = {
      kind: "exact-file" as const,
      checkId: "lint" as const,
      file: "src/value.ts",
      baseSource: source,
      edits: [
        {
          findingId: "one",
          severity: "error" as const,
          start: 14,
          end: 15,
          replacement: "",
        },
      ],
    };
    const formatted = await applyFixPlan(
      prepared(fixture.root, "src/value.ts", source, source, [
        exact,
        {
          kind: "format-file",
          checkId: "formatting",
          file: "src/value.ts",
          findingIds: ["format"],
          severities: ["error"],
          settings: DEFAULT_FORMATTING_SETTINGS,
        },
      ]),
    );
    expect(await readFile(join(fixture.root, "src/value.ts"), "utf8")).toBe(
      "const value = 1;\nconst unstaged = { value: 2 };\n",
    );
    expect(formatted.appliedFixes).toBe(2);

    const lintOnly = "const value=1;;\nconst unstaged={value:2}\n";
    await fixture.write("src/lint-only.ts", lintOnly);
    await applyFixPlan(
      prepared(fixture.root, "src/lint-only.ts", lintOnly, lintOnly, [
        { ...exact, file: "src/lint-only.ts", baseSource: lintOnly },
      ]),
    );
    expect(await readFile(join(fixture.root, "src/lint-only.ts"), "utf8")).toBe(
      "const value=1;\nconst unstaged={value:2}\n",
    );
  });

  it("reports stale and write failures independently while applying safe files", async () => {
    const fixture = await createInspectionFixture();
    await mkdir(join(fixture.root, "src"), { recursive: true });
    const source = "const value = 1;;\n";
    await writeFile(join(fixture.root, "src", "good.ts"), source);
    await writeFile(
      join(fixture.root, "src", "stale.ts"),
      "changed after preview\n",
    );
    const candidate = (file: string) => ({
      kind: "exact-file" as const,
      checkId: "lint" as const,
      file,
      baseSource: source,
      edits: [
        {
          findingId: file,
          severity: "error" as const,
          start: 16,
          end: 17,
          replacement: "",
        },
      ],
    });
    const plan = prepared(fixture.root, "src/good.ts", source, source, [
      candidate("src/good.ts"),
      candidate("src/stale.ts"),
    ]);
    const result = await applyFixPlan({
      ...plan,
      workingFiles: new Map([
        ...plan.workingFiles,
        [
          "src/stale.ts",
          {
            path: "src/stale.ts",
            content: source,
            sha256: digest(source),
            mode: 0o644,
            hasUnstagedChanges: false,
          },
        ],
      ]),
    });
    expect(await readFile(join(fixture.root, "src", "good.ts"), "utf8")).toBe(
      "const value = 1;\n",
    );
    expect(result.issues).toEqual([
      expect.objectContaining({ kind: "stale", file: "src/stale.ts" }),
    ]);
  });

  it("returns an unchanged file when formatting produces the same complete source", async () => {
    const fixture = await createInspectionFixture();
    const source = "const value = 1;\n";
    await fixture.write("src/value.ts", source);
    const result = await applyFixPlan(
      prepared(fixture.root, "src/value.ts", source, source, [
        {
          kind: "format-file",
          checkId: "formatting",
          file: "src/value.ts",
          findingIds: ["format"],
          severities: ["error"],
          settings: DEFAULT_FORMATTING_SETTINGS,
        },
      ]),
    );
    expect(result).toMatchObject({
      exitCode: 0,
      changedFiles: [],
      unchangedFiles: ["src/value.ts"],
      appliedFixes: 0,
    });
  });

  it.each([
    ["start", "abc", 0, "X", "Xabc"],
    ["middle", "abc", 1, "Y", "aYbc"],
    ["end", "abc", 3, "Z", "abcZ"],
  ])(
    "applies an unchanged-file zero-width exact insertion at %s",
    async (_position, source, offset, replacement, expected) => {
      const fixture = await createInspectionFixture();
      await fixture.write("src/value.ts", source);
      const result = await applyFixPlan(
        prepared(fixture.root, "src/value.ts", source, source, [
          {
            kind: "exact-file",
            checkId: "lint",
            file: "src/value.ts",
            baseSource: source,
            edits: [
              {
                findingId: "insert",
                severity: "error",
                start: offset,
                end: offset,
                replacement,
              },
            ],
          },
        ]),
      );
      expect(await readFile(join(fixture.root, "src/value.ts"), "utf8")).toBe(
        expected,
      );
      expect(result).toMatchObject({ exitCode: 0, appliedFixes: 1 });
    },
  );

  it("conservatively conflicts with a working insertion at the same base boundary", async () => {
    const fixture = await createInspectionFixture();
    const base = "abc";
    const working = "aXbc";
    await fixture.write("src/value.ts", working);
    const result = await applyFixPlan(
      prepared(fixture.root, "src/value.ts", base, working, [
        {
          kind: "exact-file",
          checkId: "lint",
          file: "src/value.ts",
          baseSource: base,
          edits: [
            {
              findingId: "insert",
              severity: "error",
              start: 1,
              end: 1,
              replacement: "Y",
            },
          ],
        },
      ]),
    );
    expect(await readFile(join(fixture.root, "src/value.ts"), "utf8")).toBe(
      working,
    );
    expect(result.issues).toEqual([
      expect.objectContaining({ kind: "conflict", file: "src/value.ts" }),
    ]);
  });

  it.each([
    ["start", "aXbc", "aXBc"],
    ["end", "abXc", "aBXc"],
  ])(
    "preserves an unrelated working insertion at the non-zero exact range %s boundary",
    async (_boundary, working, expected) => {
      const fixture = await createInspectionFixture();
      const base = "abc";
      await fixture.write("src/value.ts", working);
      const result = await applyFixPlan(
        prepared(fixture.root, "src/value.ts", base, working, [
          {
            kind: "exact-file",
            checkId: "lint",
            file: "src/value.ts",
            baseSource: base,
            edits: [
              {
                findingId: "replace",
                severity: "error",
                start: 1,
                end: 2,
                replacement: "B",
              },
            ],
          },
        ]),
      );
      expect(await readFile(join(fixture.root, "src/value.ts"), "utf8")).toBe(
        expected,
      );
      expect(result).toMatchObject({ exitCode: 0, appliedFixes: 1 });
    },
  );

  it.each([
    ["start", 1, "aYBc"],
    ["end", 2, "aBYc"],
  ])(
    "applies a zero-width exact insertion touching a non-zero exact range %s endpoint",
    async (_endpoint, offset, expected) => {
      const fixture = await createInspectionFixture();
      const source = "abc";
      await fixture.write("src/value.ts", source);
      const result = await applyFixPlan(
        prepared(fixture.root, "src/value.ts", source, source, [
          {
            kind: "exact-file",
            checkId: "lint",
            file: "src/value.ts",
            baseSource: source,
            edits: [
              {
                findingId: "replace",
                severity: "error",
                start: 1,
                end: 2,
                replacement: "B",
              },
            ],
          },
          {
            kind: "exact-file",
            checkId: "reactCorrectness",
            file: "src/value.ts",
            baseSource: source,
            edits: [
              {
                findingId: "insert",
                severity: "warning",
                start: offset,
                end: offset,
                replacement: "Y",
              },
            ],
          },
        ]),
      );
      expect(await readFile(join(fixture.root, "src/value.ts"), "utf8")).toBe(
        expected,
      );
      expect(result).toMatchObject({ exitCode: 0, appliedFixes: 2 });
    },
  );

  it("keeps two zero-width exact insertions at one boundary as a conflict", async () => {
    const fixture = await createInspectionFixture();
    const source = "abc";
    await fixture.write("src/value.ts", source);
    const result = await applyFixPlan(
      prepared(fixture.root, "src/value.ts", source, source, [
        {
          kind: "exact-file",
          checkId: "lint",
          file: "src/value.ts",
          baseSource: source,
          edits: [
            {
              findingId: "first",
              severity: "error",
              start: 1,
              end: 1,
              replacement: "X",
            },
          ],
        },
        {
          kind: "exact-file",
          checkId: "reactCorrectness",
          file: "src/value.ts",
          baseSource: source,
          edits: [
            {
              findingId: "second",
              severity: "warning",
              start: 1,
              end: 1,
              replacement: "Y",
            },
          ],
        },
      ]),
    );
    expect(await readFile(join(fixture.root, "src/value.ts"), "utf8")).toBe(
      source,
    );
    expect(result.issues).toEqual([
      expect.objectContaining({ kind: "conflict", file: "src/value.ts" }),
    ]);
  });

  it("reports a committed durability failure without asking callers to retry", async () => {
    const fixture = await createInspectionFixture();
    const source = "const value = 1;;\n";
    await fixture.write("src/value.ts", source);
    const result = await applyFixPlan(
      prepared(fixture.root, "src/value.ts", source, source, [
        {
          kind: "exact-file",
          checkId: "lint",
          file: "src/value.ts",
          baseSource: source,
          edits: [
            {
              findingId: "extra",
              severity: "error",
              start: 16,
              end: 17,
              replacement: "",
            },
          ],
        },
      ]),
      {
        writeWorkingFile: (request) =>
          writeWorkingFile({
            ...request,
            dependencies: {
              syncDirectory: async () => {
                throw new Error("directory sync failed");
              },
            },
          }),
      },
    );
    expect(await readFile(join(fixture.root, "src/value.ts"), "utf8")).toBe(
      "const value = 1;\n",
    );
    expect(result).toMatchObject({
      exitCode: 1,
      appliedFixes: 1,
      changedFiles: ["src/value.ts"],
      issues: [
        expect.objectContaining({
          kind: "write",
          message: expect.stringContaining("was replaced"),
          remediation: expect.stringContaining("Do not retry"),
        }),
      ],
    });
  });

  it("continues after an actual write failure while preserving another file's progress", async () => {
    const fixture = await createInspectionFixture();
    const source = "const value = 1;;\n";
    await fixture.write("src/good.ts", source);
    await fixture.write("src/bad.ts", source);
    const candidate = (file: string) => ({
      kind: "exact-file" as const,
      checkId: "lint" as const,
      file,
      baseSource: source,
      edits: [
        {
          findingId: file,
          severity: "error" as const,
          start: 16,
          end: 17,
          replacement: "",
        },
      ],
    });
    const plan = prepared(fixture.root, "src/good.ts", source, source, [
      candidate("src/good.ts"),
      candidate("src/bad.ts"),
    ]);
    const result = await applyFixPlan(
      {
        ...plan,
        workingFiles: new Map([
          ...plan.workingFiles,
          [
            "src/bad.ts",
            {
              path: "src/bad.ts",
              content: source,
              sha256: digest(source),
              mode: 0o644,
              hasUnstagedChanges: false,
            },
          ],
        ]),
      },
      {
        writeWorkingFile: async (request) => {
          if (request.file === "src/bad.ts") {
            await writeWorkingFile({
              ...request,
              dependencies: {
                write: async (handle, contents) => {
                  await handle.writeFile(contents.slice(0, 2), "utf8");
                  throw new Error("injected partial write failure");
                },
              },
            });
            return;
          }
          await writeWorkingFile(request);
        },
      },
    );
    expect(await readFile(join(fixture.root, "src/good.ts"), "utf8")).toBe(
      "const value = 1;\n",
    );
    expect(await readFile(join(fixture.root, "src/bad.ts"), "utf8")).toBe(
      source,
    );
    expect(result).toMatchObject({
      exitCode: 1,
      appliedFixes: 1,
      changedFiles: ["src/good.ts"],
      issues: [expect.objectContaining({ kind: "write", file: "src/bad.ts" })],
    });
  });
});
