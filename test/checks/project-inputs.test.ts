import { describe, expect, it } from "vitest";
import { inspectManagedCheck } from "../../src/checks/applicability.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type { ChangeSet } from "../../src/git/change-set.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../inspection/fixture.js";

describe("graph analyzer configuration applicability", () => {
  it.each([
    ["deadCode", "web/tsconfig.json", true],
    ["dependencyArchitecture", "web/tsconfig.json", true],
    ["deadCode", "config/base.json", true],
    ["dependencyArchitecture", "config/base.json", true],
    ["deadCode", "web/data.json", false],
    ["dependencyArchitecture", "web/data.json", false],
  ] as const)("%s scopes a change in %s", async (checkId, path, applies) => {
    const baseline = await createInspectionFixture();
    const target = await createInspectionFixture();
    for (const fixture of [baseline, target]) {
      for (const name of ["web", "untouched"]) {
        await fixture.writeJson(`${name}/package.json`, { name });
        await fixture.write(
          `${name}/src/index.ts`,
          "export const value = 1;\n",
        );
      }
      await fixture.writeJson("web/tsconfig.json", {
        extends: "../config/base.json",
        include: ["src"],
      });
      await fixture.writeJson("config/base.json", {
        compilerOptions: { paths: { "@/*": ["../web/src/*"] } },
      });
      await fixture.write("untouched/tsconfig.json", "{ invalid config\n");
      await fixture.writeJson("web/data.json", { value: 1 });
    }
    const changeSet: ChangeSet = {
      files: new Map([
        [
          path,
          { path, status: "modified", addedRanges: [{ start: 1, end: 1 }] },
        ],
      ]),
      isEmpty: false,
      containsAddedLine: (file, line) => file === path && line === 1,
    };
    const result = await inspectManagedCheck(checkId, {
      repositoryRoot: target.root,
      baselineInspection: await inspectRepository(baseline.root),
      targetInspection: await inspectRepository(target.root),
      changeSet,
      config: resolveConfig({ schemaVersion: 1, profile: "thorough" }),
    });

    expect(result).toMatchObject(
      applies
        ? {
            applies: true,
            targets: [{ id: "web", kind: "workspace", relativeRoot: "web" }],
          }
        : { applies: false },
    );
  });
});
