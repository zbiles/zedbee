import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import {
  loadSnapshotProgramInput,
  loadSnapshotProgramProjects,
} from "../../../src/checks/typescript/config.js";
import {
  createAnalysisReuseSession,
  withAnalysisReuseSession,
} from "../../../src/checks/analysis-reuse.js";
import {
  captureAnalysisSources,
  withAnalysisSourceCapture,
} from "../../../src/inspection/source-capture.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../inspection/fixture.js";
import {
  countContainedSourceReads,
  restoreAnalysisProbes,
} from "../../helpers/analysis-probes.js";

afterEach(restoreAnalysisProbes);

async function fixture() {
  const fixture = await createInspectionFixture();
  await fixture.writeJson("package.json", {
    name: "compiler-inputs",
    private: true,
  });
  await fixture.writeJson("tsconfig.json", {
    include: ["src"],
    compilerOptions: { strict: true },
  });
  await fixture.write("src/value.ts", "export const value = 1;");
  return {
    fixture,
    workspace: (await inspectRepository(fixture.root)).workspaces[0]!,
  };
}

describe("validated compiler input preparation", () => {
  it("never substitutes workspace roots into an empty solution project", async () => {
    const { fixture: value, workspace } = await fixture();
    await value.writeJson("tsconfig.json", {
      files: [],
      references: [{ path: "./config/empty.json" }],
    });
    await value.writeJson("config/empty.json", { files: [] });
    expect(
      (await loadSnapshotProgramInput(value.root, value.root, workspace))
        .rootNames,
    ).toEqual([]);
  });

  it("keeps preferred and explicitly referenced projects when also extended", async () => {
    const { fixture: value, workspace } = await fixture();
    await value.writeJson("tsconfig.base.json", {
      compilerOptions: { strict: true, composite: true },
      include: ["src"],
    });
    await value.writeJson("tsconfig.json", {
      extends: "./tsconfig.base.json",
      files: [],
      references: [{ path: "./tsconfig.base.json" }],
    });
    await value.writeJson("tsconfig.tools.json", {
      extends: "./tsconfig.json",
      files: [],
      references: [{ path: "./tsconfig.base.json" }],
    });
    const projects = await loadSnapshotProgramProjects(value.root, value.root, {
      ...workspace,
      tsconfigPaths: [
        "tsconfig.base.json",
        "tsconfig.json",
        "tsconfig.tools.json",
      ],
    });
    expect(projects.map(({ configPath }) => configPath)).toEqual([
      "tsconfig.json",
      "tsconfig.tools.json",
    ]);
    expect(projects[0]!.input.projectReferences).toHaveLength(1);
  });

  it("recognizes a base reached from a later sibling without adding its implicit roots", async () => {
    const { fixture: value, workspace } = await fixture();
    await value.writeJson("tsconfig.base.json", {
      compilerOptions: { strict: true },
    });
    await value.writeJson("tsconfig.tools.json", {
      extends: "./tsconfig.base.json",
      include: ["tools"],
    });
    await value.write("tools/build.ts", "export const build = 1;");
    await value.write("loose.ts", "export const loose = 1;");
    const projects = await loadSnapshotProgramProjects(value.root, value.root, {
      ...workspace,
      sourceFiles: [...workspace.sourceFiles, "tools/build.ts", "loose.ts"],
      tsconfigPaths: [
        "tsconfig.json",
        "tsconfig.base.json",
        "tsconfig.tools.json",
      ],
    });
    expect(projects.map(({ configPath }) => configPath)).toEqual([
      "tsconfig.json",
      "tsconfig.tools.json",
    ]);
    expect(projects.flatMap(({ input }) => input.rootNames).sort()).toEqual([
      "src/value.ts",
      "tools/build.ts",
    ]);
  });

  it("does not promote the first fallback helper when canonical tsconfig is absent", async () => {
    const value = await createInspectionFixture();
    await value.writeJson("package.json", { name: "fallback", private: true });
    await value.writeJson("tsconfig.base.json", {
      compilerOptions: { strict: true },
    });
    await value.writeJson("tsconfig.build.json", {
      extends: "./tsconfig.base.json",
      include: ["src"],
    });
    await value.write("src/index.ts", "export const value = 1;");
    await value.write("loose.ts", "export const loose = 1;");
    const workspace = (await inspectRepository(value.root)).workspaces[0]!;
    expect(workspace.tsconfigPaths[0]).toBe("tsconfig.base.json");
    const projects = await loadSnapshotProgramProjects(
      value.root,
      value.root,
      workspace,
    );
    expect(projects.map(({ configPath }) => configPath)).toEqual([
      "tsconfig.build.json",
    ]);
    expect(projects.flatMap(({ input }) => input.rootNames)).toEqual([
      "src/index.ts",
    ]);
  });

  it("retains an extended sibling with its own source selectors", async () => {
    const { fixture: value, workspace } = await fixture();
    await value.writeJson("tsconfig.lib.json", {
      compilerOptions: { strict: true },
      include: ["lib"],
    });
    await value.writeJson("tsconfig.json", {
      extends: "./tsconfig.lib.json",
      include: ["src"],
    });
    await value.write("lib/index.ts", "export const library = 1;");
    const projects = await loadSnapshotProgramProjects(value.root, value.root, {
      ...workspace,
      sourceFiles: [...workspace.sourceFiles, "lib/index.ts"],
      tsconfigPaths: ["tsconfig.json", "tsconfig.lib.json"],
    });
    expect(projects.map(({ configPath }) => configPath)).toEqual([
      "tsconfig.json",
      "tsconfig.lib.json",
    ]);
    expect(projects.flatMap(({ input }) => input.rootNames).sort()).toEqual([
      "lib/index.ts",
      "src/value.ts",
    ]);
  });

  it("coalesces concurrent preparation within one owner", async () => {
    const { fixture: value, workspace } = await fixture();
    const reads = countContainedSourceReads("/tsconfig.json");
    const owner = createAnalysisReuseSession();
    try {
      await withAnalysisReuseSession(owner, async () => {
        const inputs = await Promise.all(
          Array.from({ length: 4 }, () =>
            loadSnapshotProgramProjects(value.root, value.root, workspace),
          ),
        );
        expect(inputs.map(([project]) => project!.input.rootNames)).toEqual(
          Array.from({ length: 4 }, () => ["src/value.ts"]),
        );
        expect(reads()).toBe(1);
        expect(
          inputs.every(
            ([project]) =>
              project!.input.options === inputs[0]![0]!.input.options,
          ),
        ).toBe(true);
      });
    } finally {
      await owner.close();
    }
  });

  it("acquires each unselected input once across eight captured workspaces", async () => {
    const value = await createInspectionFixture();
    await value.writeJson("package.json", {
      name: "root",
      private: true,
      workspaces: ["packages/*"],
    });
    const paths: string[] = [];
    for (let workspace = 0; workspace < 8; workspace++) {
      const prefix = `packages/p${workspace}`;
      await value.writeJson(`${prefix}/package.json`, {
        name: `p${workspace}`,
        private: true,
      });
      await value.writeJson(`${prefix}/tsconfig.json`, { include: ["src"] });
      for (let file = 0; file < 25; file++) {
        const path = `${prefix}/src/f${file}.ts`;
        paths.push(path);
        await value.write(path, `export const value = ${file};`);
      }
    }
    const inspection = await inspectRepository(value.root);
    const capture = (await captureAnalysisSources([
      { snapshotRoot: value.root, paths },
    ]))!;
    const opened = new Map<string, number>();
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      const path = String(args[0]);
      opened.set(path, (opened.get(path) ?? 0) + 1);
      return Reflect.apply(open, fs, args);
    });
    const readDirectory = fs.readdir;
    let inventories = 0;
    vi.spyOn(fs, "readdir").mockImplementation((...args) => {
      if (String(args[0]) === inspection.snapshotRoot) inventories++;
      return Reflect.apply(readDirectory, fs, args);
    });
    syncBuiltinESMExports();
    const owner = createAnalysisReuseSession();
    try {
      await withAnalysisReuseSession(owner, () =>
        withAnalysisSourceCapture(capture, async () => {
          for (const workspace of inspection.workspaces.filter(
            ({ relativeRoot }) => relativeRoot !== ".",
          )) {
            const projects = await loadSnapshotProgramProjects(
              value.root,
              value.root,
              workspace,
            );
            expect(projects[0]!.input.rootNames).toHaveLength(25);
          }
        }),
      );
      expect(inventories).toBe(1);
      expect(opened.size).toBe(17);
      expect([...opened.values()]).toEqual(Array.from({ length: 17 }, () => 1));
    } finally {
      await owner.close();
      await capture.close();
    }
  });

  it("shares acquired sources and parsed configuration within the analysis owner", async () => {
    const { fixture: value, workspace } = await fixture();
    const reads = countContainedSourceReads("/tsconfig.json");
    const owner = createAnalysisReuseSession();
    try {
      await withAnalysisReuseSession(owner, async () => {
        const first = await loadSnapshotProgramProjects(
          value.root,
          value.root,
          workspace,
        );
        const second = await loadSnapshotProgramProjects(
          value.root,
          value.root,
          { ...workspace },
        );
        expect(second[0]!.input.options).toBe(first[0]!.input.options);
        expect(reads()).toBe(1);
      });
    } finally {
      await owner.close();
    }
    const fresh = createAnalysisReuseSession();
    try {
      await withAnalysisReuseSession(fresh, () =>
        loadSnapshotProgramProjects(value.root, value.root, workspace),
      );
      expect(reads()).toBe(2);
    } finally {
      await fresh.close();
    }
  });

  it("does not repopulate an owner closed during acquisition", async () => {
    const { fixture: value, workspace } = await fixture();
    let started!: () => void;
    const opened = new Promise<void>((resolve) => {
      started = resolve;
    });
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("value.ts")) {
        started();
        await blocked;
      }
      return Reflect.apply(open, fs, args);
    });
    syncBuiltinESMExports();
    const owner = createAnalysisReuseSession();
    const running = withAnalysisReuseSession(owner, () =>
      loadSnapshotProgramProjects(value.root, value.root, workspace),
    );
    const rejected = expect(running).rejects.toThrow(/closed/i);
    await opened;
    await owner.close();
    release();
    await rejected;
    const fresh = createAnalysisReuseSession();
    try {
      await withAnalysisReuseSession(fresh, async () => {
        expect(
          (
            await loadSnapshotProgramProjects(value.root, value.root, workspace)
          )[0]!.input.rootNames,
        ).toEqual(["src/value.ts"]);
      });
    } finally {
      await fresh.close();
    }
  });

  it("invalidates same-size live bytes with restored mtime and directory additions", async () => {
    const { fixture: value, workspace } = await fixture();
    const owner = createAnalysisReuseSession();
    try {
      await withAnalysisReuseSession(owner, async () => {
        const before = await stat(join(value.root, "src/value.ts"));
        await loadSnapshotProgramProjects(value.root, value.root, workspace);
        await value.write("src/value.ts", "export const value = 2;");
        await utimes(
          join(value.root, "src/value.ts"),
          before.atime,
          before.mtime,
        );
        const second = await loadSnapshotProgramProjects(
          value.root,
          value.root,
          workspace,
        );
        expect(second[0]!.input.files["src/value.ts"]).toBe(
          "export const value = 2;",
        );
        await value.write("src/new.ts", "export const added = true;");
        const updated = {
          ...workspace,
          sourceFiles: [...workspace.sourceFiles, "src/new.ts"],
        };
        expect(
          (
            await loadSnapshotProgramProjects(value.root, value.root, updated)
          )[0]!.input.rootNames,
        ).toContain("src/new.ts");
        await value.writeJson("tsconfig.json", {
          include: ["src"],
          compilerOptions: { strict: false },
        });
        expect(
          (
            await loadSnapshotProgramProjects(value.root, value.root, updated)
          )[0]!.input.options.strict,
        ).toBe(false);
      });
    } finally {
      await owner.close();
    }
  });

  it("isolates source capture owners and keeps captured deletions visible", async () => {
    const { fixture: value, workspace } = await fixture();
    const selections = [{ snapshotRoot: value.root, paths: ["src/value.ts"] }];
    const old = (await captureAnalysisSources(selections))!;
    const owner = createAnalysisReuseSession();
    try {
      await withAnalysisReuseSession(owner, async () => {
        const load = () =>
          loadSnapshotProgramProjects(value.root, value.root, workspace);
        await withAnalysisSourceCapture(old, load);
        await value.write("src/value.ts", "export const value = 2;");
        const fresh = (await captureAnalysisSources(selections))!;
        try {
          await withAnalysisSourceCapture(fresh, async () =>
            expect((await load())[0]!.input.files["src/value.ts"]).toBe(
              "export const value = 2;",
            ),
          );
        } finally {
          await fresh.close();
        }
        await unlink(join(value.root, "src/value.ts"));
        await withAnalysisSourceCapture(old, async () =>
          expect((await load())[0]!.input.files["src/value.ts"]).toBe(
            "export const value = 1;",
          ),
        );
      });
    } finally {
      await owner.close();
      await old.close();
    }
    await expect(
      withAnalysisReuseSession(owner, async () => undefined),
    ).rejects.toThrow(/closed/i);
  });
});
