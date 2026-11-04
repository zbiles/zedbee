import * as fsPromises from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { compilerConfigurationPaths } from "../../src/checks/typescript/configuration-paths.js";
import { inspectManagedCheck } from "../../src/checks/applicability.js";
import { resolveConfig } from "../../src/config/profiles.js";
import type { ChangeSet } from "../../src/git/change-set.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../inspection/fixture.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: vi.fn(actual.readdir),
    lstat: vi.fn(actual.lstat),
    open: vi.fn(actual.open),
  };
});

describe("graph analyzer configuration applicability", () => {
  it("follows transitive extends and directory references, retaining missing roots and stopping cycles", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("web/package.json", { name: "web" });
    await fixture.writeJson("web/tsconfig.json", {
      extends: ["../config/base", "./missing"],
      references: [{ path: "../shared" }],
    });
    await fixture.writeJson("config/base.json", { extends: "./deep.json" });
    await fixture.writeJson("config/deep.json", { extends: "./base.json" });
    await fixture.writeJson("shared/tsconfig.json", {
      references: [{ path: "../nested/config.json" }],
    });
    await fixture.writeJson("nested/config.json", {});
    const inspection = await inspectRepository(fixture.root);
    const workspace = inspection.workspaces.find(
      ({ relativeRoot }) => relativeRoot === "web",
    )!;
    expect(
      [
        ...(await compilerConfigurationPaths(inspection.snapshotRoot, {
          ...workspace,
          tsconfigPaths: [...workspace.tsconfigPaths, "web/missing-root.json"],
        })),
      ].sort(),
    ).toEqual([
      "config/base.json",
      "config/deep.json",
      "nested/config.json",
      "shared/tsconfig.json",
      "web/missing-root.json",
      "web/tsconfig.json",
    ]);
  });

  it("accepts contained config aliases while excluding external and ignored targets", async () => {
    const fixture = await createInspectionFixture();
    const outside = await createInspectionFixture();
    await fixture.writeJson("web/package.json", { name: "web" });
    await fixture.writeJson("web/tsconfig.json", {
      extends: [
        "../config/alias.json",
        "../external.json",
        "../ignored.json",
        "../../escape.json",
      ],
    });
    await fixture.writeJson("config/base.json", { extends: "./deep.json" });
    await fixture.writeJson("config/deep.json", {});
    await fixture.writeJson("node_modules/private/config.json", {
      extends: "../../leaked.json",
    });
    await fixture.writeJson("node_modules/leaked.json", {});
    await outside.writeJson("external.json", {
      extends: "./must-not-follow.json",
    });
    const inspection = await inspectRepository(fixture.root);
    await fixture.symlink("base.json", "config/alias.json");
    await fixture.symlink("node_modules/private/config.json", "ignored.json");
    await fixture.symlink(`${outside.root}/external.json`, "external.json");
    const workspace = inspection.workspaces.find(
      ({ relativeRoot }) => relativeRoot === "web",
    )!;
    expect(
      [
        ...(await compilerConfigurationPaths(
          inspection.snapshotRoot,
          workspace,
        )),
      ].sort(),
    ).toEqual(["config/alias.json", "config/deep.json", "web/tsconfig.json"]);
  });

  it("shares targeted configuration acquisition across workspace checks without inventorying unrelated files", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "root",
      workspaces: ["p*"],
    });
    await fixture.writeJson("config/base.json", { extends: "./nested.json" });
    await fixture.writeJson("config/nested.json", {});
    for (let i = 0; i < 12; i++) {
      await fixture.writeJson(`p${i}/package.json`, { name: `p${i}` });
      await fixture.writeJson(`p${i}/tsconfig.json`, {
        extends: "../config/base.json",
      });
      await fixture.write(`p${i}/source.ts`, "export const value = 1;");
      for (let j = 0; j < 10; j++)
        await fixture.write(`p${i}/unrelated-${j}.txt`, "unrelated");
    }
    const inspection = await inspectRepository(fixture.root);
    const context = {
      repositoryRoot: fixture.root,
      baselineInspection: inspection,
      targetInspection: inspection,
      changeSet: {
        files: new Map([
          [
            "README.md",
            {
              path: "README.md",
              status: "modified" as const,
              addedRanges: [{ start: 1, end: 1 }],
            },
          ],
        ]),
        isEmpty: false,
        containsAddedLine: () => false,
      },
      config: resolveConfig({ schemaVersion: 1, profile: "thorough" }),
    };
    vi.mocked(fsPromises.readdir).mockClear();
    vi.mocked(fsPromises.lstat).mockClear();
    vi.mocked(fsPromises.open).mockClear();
    for (const check of ["deadCode", "dependencyArchitecture"] as const)
      expect(await inspectManagedCheck(check, context)).toMatchObject({
        applies: false,
      });
    expect(vi.mocked(fsPromises.readdir).mock.calls).toHaveLength(0);
    expect(vi.mocked(fsPromises.lstat).mock.calls.length).toBeLessThan(500);
    expect(
      vi
        .mocked(fsPromises.open)
        .mock.calls.filter(([path]) =>
          String(path).endsWith("/config/base.json"),
        ),
    ).toHaveLength(1);
  });

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
