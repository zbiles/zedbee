import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("graph findings caused by inherited alias configuration", () => {
  it.each(["deadCode", "dependencyArchitecture"] as const)(
    "attributes %s findings after changing only the inherited mapping",
    async (checkId) => {
      const repo = await createGitRepository("zedbee-inherited-alias-input-");
      await repo.write(
        "package.json",
        JSON.stringify({ name: "app", private: true, main: "src/index.ts" }),
      );
      await repo.write(
        ".zedbeerc.jsonc",
        JSON.stringify({
          schemaVersion: 1,
          checks: Object.fromEntries(
            CHECK_IDS.map((id) => [id, id === checkId ? "error" : "off"]),
          ),
        }),
      );
      await repo.write(
        "tsconfig.json",
        JSON.stringify({
          extends: "./config/base.json",
          compilerOptions: { module: "ESNext", moduleResolution: "bundler" },
          include: ["src"],
        }),
      );
      const configuration = (selected: string) =>
        JSON.stringify({
          compilerOptions: {
            paths: { "@/selected": [selected], "@/entry": ["../src/index.ts"] },
          },
        });
      await repo.write("config/base.json", configuration("../src/safe.ts"));
      await repo.write(
        "src/index.ts",
        'import { value } from "@/selected";\nexport const result = value;\n',
      );
      await repo.write("src/safe.ts", "export const value = 1;\n");
      if (checkId === "dependencyArchitecture") {
        await repo.write(
          "src/cycle.ts",
          'import { result } from "@/entry";\nexport const value = result;\n',
        );
      }
      await repo.write(
        "untouched/package.json",
        '{"name":"untouched","private":true}\n',
      );
      await repo.write("untouched/tsconfig.json", "{ invalid config\n");
      await repo.write(
        "untouched/src/index.ts",
        "export const untouched = 1;\n",
      );
      await repo.commitAll("baseline aliases and unrelated configuration debt");
      await repo.write(
        "config/base.json",
        configuration(
          checkId === "deadCode" ? "../src/missing.ts" : "../src/cycle.ts",
        ),
      );
      await repo.git(["add", "config/base.json"]);

      const report = await runScan({ repositoryRoot: repo.root, cache: false });

      expect(report, JSON.stringify(report)).toMatchObject({
        outcome: "blocked",
        exitCode: 1,
      });
      expect(report.checks.every((check) => check.status === "completed")).toBe(
        true,
      );
      expect(report.checks.map((check) => check.target)).toEqual(["."]);
      expect(report.summary.findings).toContainEqual(
        expect.objectContaining({
          check: checkId,
          rule: checkId === "deadCode" ? "unresolved" : "no-circular",
          location: expect.objectContaining({ file: "src/index.ts" }),
          attribution: expect.objectContaining({ staged: true }),
        }),
      );
    },
  );
});
