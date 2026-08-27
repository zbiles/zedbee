import { createHash } from "node:crypto";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { applyFixPlan } from "../../src/fixes/apply-plan.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../src/checks/prettier/settings.js";
import type { PreparedFixPlan } from "../../src/fixes/types.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("managed fixes preserve Git's index", () => {
  it("keeps a partial index byte-for-byte intact while formatting complete working content", async () => {
    const repository = await createGitRepository("zedbee-fix-partial-staged-");
    const clean = "const value = 1;\n";
    const staged = "const value=1;;\n";
    const working = "const value=1;;\nconst unstaged={value:2}\n";
    await repository.write(
      "package.json",
      '{"name":"fixture","private":true}\n',
    );
    await repository.write("src/value.ts", clean);
    await repository.commitAll("baseline");
    await repository.write("src/value.ts", staged);
    await repository.git(["add", "--", "src/value.ts"]);
    await repository.write("src/value.ts", working);
    const beforeTree = (await repository.git(["write-tree"])).stdout;
    const beforeCached = (
      await repository.git(["diff", "--cached", "--binary"])
    ).stdout;
    const plan: PreparedFixPlan = {
      repositoryRoot: repository.root,
      temporaryReportMaxAgeMs: 60_000,
      publicPlan: {
        schemaVersion: 1,
        target: "index",
        selectedChecks: ["formatting", "lint"],
        exitCode: 0,
        summary: { fixes: 2, files: 1, blocking: 2, warnings: 0, skipped: 0 },
        files: [{ path: "src/value.ts", fixes: 2, hasUnstagedChanges: true }],
        items: [],
      },
      workingFiles: new Map([
        [
          "src/value.ts",
          {
            path: "src/value.ts",
            content: working,
            sha256: createHash("sha256").update(working, "utf8").digest("hex"),
            mode: 0o644,
            hasUnstagedChanges: true,
          },
        ],
      ]),
      candidates: [
        {
          kind: "exact-file",
          checkId: "lint",
          file: "src/value.ts",
          baseSource: staged,
          edits: [
            {
              findingId: "extra-semi",
              severity: "error",
              start: 14,
              end: 15,
              replacement: "",
            },
          ],
        },
        {
          kind: "format-file",
          checkId: "formatting",
          file: "src/value.ts",
          findingIds: ["format"],
          severities: ["error"],
          settings: DEFAULT_FORMATTING_SETTINGS,
        },
      ],
    };

    await expect(applyFixPlan(plan)).resolves.toMatchObject({
      exitCode: 0,
      appliedFixes: 2,
    });
    expect(await repository.read("src/value.ts")).toBe(
      "const value = 1;\nconst unstaged = { value: 2 };\n",
    );
    expect((await repository.git(["write-tree"])).stdout).toBe(beforeTree);
    expect(
      (await repository.git(["diff", "--cached", "--binary"])).stdout,
    ).toBe(beforeCached);
    const unstagedPatch = (
      await repository.git(["diff", "--binary", "--", "src/value.ts"])
    ).stdout;
    expect(unstagedPatch.endsWith("\n")).toBe(false);
    await expect(
      execa("git", ["apply", "--cached", "--check"], {
        cwd: repository.root,
        input: `${unstagedPatch}\n`,
      }),
    ).resolves.toBeDefined();
  });
});
