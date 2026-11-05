import * as fsPromises from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import {
  loadSnapshotProgramInput,
  SnapshotConfigurationError,
} from "../../src/checks/typescript/config.js";
import { compilerConfigurationPaths } from "../../src/checks/typescript/configuration-paths.js";
import { projectInputsMayHaveChanged } from "../../src/checks/project-inputs.js";
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
    ).toEqual([
      "config/alias.json",
      "config/base.json",
      "config/deep.json",
      "web/tsconfig.json",
    ]);
  });

  it("records intermediate file links and directory links without changing lexical extends bases", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("web/package.json", { name: "web" });
    await fixture.writeJson("web/tsconfig.json", {
      extends: "../alias/config.json",
    });
    await fixture.writeJson("canonical/base.json", {
      extends: "./relative.json",
    });
    await fixture.writeJson("deep/actual/relative.json", {});
    await fixture.writeJson("canonical/relative.json", {
      extends: "./must-not-follow.json",
    });
    await fixture.writeJson("canonical/must-not-follow.json", {});
    await fixture.symlink(
      "../elsewhere/middle.json",
      "deep/actual/config.json",
    );
    await fixture.symlink(
      "../../canonical/base.json",
      "deep/elsewhere/middle.json",
    );
    await fixture.symlink("deep/actual", "alias");
    const inspection = await inspectRepository(fixture.root);
    const workspace = inspection.workspaces.find(
      ({ relativeRoot }) => relativeRoot === "web",
    )!;
    const paths = await compilerConfigurationPaths(
      inspection.snapshotRoot,
      workspace,
    );
    expect([...paths]).toEqual(
      expect.arrayContaining([
        "web/tsconfig.json",
        "alias",
        "alias/config.json",
        "deep/elsewhere/middle.json",
        "canonical/base.json",
        "alias/relative.json",
        "deep/actual/relative.json",
      ]),
    );
    expect(paths.has("canonical/relative.json")).toBe(false);
    expect(paths.has("canonical/must-not-follow.json")).toBe(false);
    for (const path of [
      "canonical/base.json",
      "deep/elsewhere/middle.json",
      "alias",
    ]) {
      const context = {
        repositoryRoot: fixture.root,
        baselineInspection: inspection,
        targetInspection: inspection,
        config: resolveConfig({ schemaVersion: 1, profile: "thorough" }),
        changeSet: {
          files: new Map([
            [path, { path, status: "modified" as const, addedRanges: [] }],
          ]),
          isEmpty: false,
          containsAddedLine: () => false,
        },
      };
      expect(
        await projectInputsMayHaveChanged(context, {
          id: "web",
          kind: "workspace",
          relativeRoot: "web",
        }),
      ).toBe(true);
    }
  });

  it.each(["deadCode", "dependencyArchitecture"] as const)(
    "%s schedules JavaScript workspaces for canonical-target-only invalid inherited config changes",
    async (checkId) => {
      const baseline = await createInspectionFixture();
      const target = await createInspectionFixture();
      for (const fixture of [baseline, target]) {
        await fixture.writeJson("web/package.json", {
          name: "web",
          type: "module",
        });
        await fixture.write("web/src/index.js", "export const value = 1;");
        await fixture.writeJson("web/tsconfig.json", {
          extends: "../config/alias.json",
          include: ["src"],
          compilerOptions: { allowJs: true },
        });
        await fixture.writeJson("config/base.json", {
          compilerOptions: { paths: { "@/*": ["../web/src/*"] } },
        });
        await fixture.symlink("middle.json", "config/alias.json");
        await fixture.symlink("base.json", "config/middle.json");
      }
      await target.write(
        "config/base.json",
        "{ invalid inherited configuration",
      );
      const baselineInspection = await inspectRepository(baseline.root);
      const targetInspection = await inspectRepository(target.root);
      const workspace = targetInspection.workspaces.find(
        ({ relativeRoot }) => relativeRoot === "web",
      )!;
      const context = {
        repositoryRoot: target.root,
        baselineInspection,
        targetInspection,
        config: resolveConfig({ schemaVersion: 1, profile: "thorough" }),
        changeSet: {
          files: new Map([
            [
              "config/base.json",
              {
                path: "config/base.json",
                status: "modified" as const,
                addedRanges: [],
              },
            ],
          ]),
          isEmpty: false,
          containsAddedLine: () => false,
        },
      };
      expect(await inspectManagedCheck(checkId, context)).toMatchObject({
        applies: true,
        targets: [{ id: "web", kind: "workspace", relativeRoot: "web" }],
      });
      expect(
        await projectInputsMayHaveChanged(
          context,
          { id: "web", kind: "workspace", relativeRoot: "web" },
          "deletions",
        ),
      ).toBe(true);
      await expect(
        loadSnapshotProgramInput(
          targetInspection.snapshotRoot,
          targetInspection.snapshotRoot,
          workspace,
        ),
      ).rejects.toBeInstanceOf(SnapshotConfigurationError);
    },
  );

  it("prepares changed/deleted and workspace indexes once per immutable scan input", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "root",
      workspaces: ["p*"],
    });
    for (let i = 0; i < 12; i++) {
      await fixture.writeJson(`p${i}/package.json`, { name: `p${i}` });
      await fixture.write(`p${i}/source.js`, "export const value = 1;");
    }
    const inspection = await inspectRepository(fixture.root);
    let pathReads = 0;
    let rootReads = 0;
    const countedInspection = {
      ...inspection,
      workspaces: inspection.workspaces.map((workspace) => ({
        ...workspace,
        get relativeRoot() {
          rootReads++;
          return workspace.relativeRoot;
        },
      })),
    };
    const files = new Map(
      Array.from({ length: 100 }, (_, i) => {
        const path = `unrelated-${i}.txt`;
        return [
          path,
          {
            get path() {
              pathReads++;
              return path;
            },
            status: "deleted" as const,
            addedRanges: [],
          },
        ] as const;
      }),
    );
    const context = {
      repositoryRoot: fixture.root,
      baselineInspection: countedInspection,
      targetInspection: countedInspection,
      config: resolveConfig({ schemaVersion: 1, profile: "thorough" }),
      changeSet: { files, isEmpty: false, containsAddedLine: () => false },
    };
    for (const mode of ["all", "deletions"] as const)
      for (let i = 0; i < 12; i++)
        expect(
          await projectInputsMayHaveChanged(
            { ...context },
            { id: `p${i}`, kind: "workspace", relativeRoot: `p${i}` },
            mode,
          ),
        ).toBe(false);
    expect(pathReads).toBeLessThanOrEqual(200);
    expect(rootReads).toBeLessThanOrEqual(inspection.workspaces.length);
    // Replacing the change set must not reuse an earlier scan's paths.
    expect(
      await projectInputsMayHaveChanged(
        {
          ...context,
          changeSet: {
            ...context.changeSet,
            files: new Map([
              [
                "p0/source.js",
                { path: "p0/source.js", status: "deleted", addedRanges: [] },
              ],
            ]),
          },
        },
        { id: "p0", kind: "workspace", relativeRoot: "p0" },
        "deletions",
      ),
    ).toBe(true);
  });

  it("keeps merge-comparison workspace membership work linear", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "root",
      workspaces: ["p*"],
    });
    for (let index = 0; index < 40; index++) {
      await fixture.writeJson(`p${index}/package.json`, { name: `p${index}` });
      await fixture.write(`p${index}/source.js`, "export const value = 1;");
    }
    const inspection = await inspectRepository(fixture.root);
    let rootReads = 0;
    const countedInspection = {
      ...inspection,
      workspaces: inspection.workspaces.map((workspace) => ({
        ...workspace,
        get relativeRoot() {
          rootReads++;
          return workspace.relativeRoot;
        },
      })),
    };
    const context = {
      repositoryRoot: fixture.root,
      baselineInspection: countedInspection,
      targetInspection: countedInspection,
      mergeComparison: true,
      config: resolveConfig({ schemaVersion: 1, profile: "thorough" }),
      changeSet: {
        files: new Map([
          [
            "README.md",
            { path: "README.md", status: "modified" as const, addedRanges: [] },
          ],
        ]),
        isEmpty: false,
        containsAddedLine: () => false,
      },
    };
    for (const check of ["deadCode", "dependencyArchitecture"] as const)
      expect(await inspectManagedCheck(check, context)).toMatchObject({
        applies: false,
      });
    expect(rootReads).toBeLessThanOrEqual(inspection.workspaces.length * 16);
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
