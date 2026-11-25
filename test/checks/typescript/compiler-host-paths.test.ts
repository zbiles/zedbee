import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CapturedDependencies } from "../../../src/cache/captured-dependencies.js";
import { createSnapshotProgram } from "../../../src/checks/typescript/compiler-host.js";
import { createInspectionFixture } from "../../inspection/fixture.js";

const captured = vi.hoisted(() => ({ hosts: [] as ts.CompilerHost[] }));
vi.mock("typescript", async (importOriginal) => {
  const actual = await importOriginal<typeof import("typescript")>();
  return {
    ...actual,
    createProgram(options: ts.CreateProgramOptions) {
      captured.hosts.push(options.host!);
      return actual.createProgram(options);
    },
  };
});
afterEach(() => {
  captured.hosts.length = 0;
  vi.restoreAllMocks();
});

// TS uses this same internal API when rendering external type names in errors.
const moduleSpecifiers = (
  ts as typeof ts & {
    moduleSpecifiers: {
      getLocalModuleSpecifierBetweenFileNames(
        source: ts.SourceFile,
        target: string,
        options: ts.CompilerOptions,
        host: ts.CompilerHost & {
          getDefaultResolutionModeForFile(): ts.ModuleKind;
        },
        preferences: object,
      ): string;
    };
  }
).moduleSpecifiers;

function configOptions(base: string, extra: object = {}) {
  return ts.parseJsonConfigFileContent(
    {
      compilerOptions: {
        module: "esnext",
        moduleResolution: "bundler",
        paths: { "@/*": ["./*"] },
        types: [],
        ...extra,
      },
    },
    { ...ts.sys, readDirectory: () => [] },
    base,
    undefined,
    path.join(base, "tsconfig.json"),
  ).options;
}

async function installedReact(root: string) {
  const target = path.join(root, "web/node_modules/@types/react");
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.cp(
    path.dirname(
      fileURLToPath(import.meta.resolve("@types/react/package.json")),
    ),
    target,
    { recursive: true },
  );
  return path.join(target, "index.d.ts");
}

describe("compiler lookup path context", () => {
  it.each(["repository", "web", "driver"])(
    "normalizes TS6 alias diagnostic probes independently of %s cwd",
    async (cwd) => {
      const fixture = await createInspectionFixture();
      const repositoryRoot = path.join(
        fixture.root,
        "repo/.claude/worktrees/topic",
      );
      const target = await installedReact(repositoryRoot);
      const roots = {
        baselineDir: path.join(fixture.root, "snapshots/baseline"),
        targetDir: path.join(fixture.root, "deeper/snapshots/target"),
      };
      const cwdRoot = {
        repository: repositoryRoot,
        web: path.join(repositoryRoot, "web"),
        driver: path.join(fixture.root, "separate-driver"),
      }[cwd];
      // Vitest worker threads cannot chdir; resolve(path) reads this same API.
      vi.spyOn(process, "cwd").mockReturnValue(cwdRoot!);
      for (const snapshotRoot of Object.values(roots)) {
        const base = path.join(snapshotRoot, "web");
        const dependencies = new CapturedDependencies({
          repositoryRoot,
          snapshots: roots,
        });
        const probes = vi.spyOn(dependencies, "fileExists");
        const result = createSnapshotProgram({
          repositoryRoot,
          snapshotRoot,
          dependencies,
          files: { "web/main.ts": "export {};" },
          rootNames: ["web/main.ts"],
          options: configOptions(base, { noLib: true }),
        });
        const host = captured.hosts.at(-1)!;
        probes.mockClear();
        const rawProbes: string[] = [];
        moduleSpecifiers.getLocalModuleSpecifierBetweenFileNames(
          result.program.getSourceFile(path.join(base, "main.ts"))!,
          target,
          result.program.getCompilerOptions(),
          {
            ...host,
            getDefaultResolutionModeForFile: () => ts.ModuleKind.ESNext,
            fileExists: (raw) => {
              rawProbes.push(raw);
              return host.fileExists(raw);
            },
          },
          {},
        );
        expect(rawProbes.length).toBeGreaterThan(0);
        expect(rawProbes.some((raw) => !path.isAbsolute(raw))).toBe(true);
        expect(probes.mock.calls.map(([probe]) => probe)).toEqual(
          expect.arrayContaining(
            rawProbes.filter(
              (raw) =>
                path.isAbsolute(raw) &&
                !raw.startsWith(snapshotRoot + path.sep),
            ),
          ),
        );
        expect(
          probes.mock.calls.every(
            ([probe]) => !probe.startsWith(snapshotRoot + path.sep),
          ),
        ).toBe(true);
        expect(probes.mock.calls.map(([probe]) => probe)).toContain(
          path.resolve(path.dirname(target), "../react.ts"),
        );
        expect(dependencies.manifest()).toBeDefined();
      }
    },
  );

  it("uses the alias base consistently for relative filesystem operations", async () => {
    const fixture = await createInspectionFixture();
    const repositoryRoot = path.join(fixture.root, "repository");
    const target = await installedReact(repositoryRoot);
    const snapshotRoot = path.join(fixture.root, "snapshot");
    const configRoot = path.join(snapshotRoot, "web/config");
    const aliasBase = path.join(snapshotRoot, "web/source");
    const dependencies = new CapturedDependencies({ repositoryRoot });
    createSnapshotProgram({
      repositoryRoot,
      snapshotRoot,
      dependencies,
      files: {
        "web/source/main.ts": "export {};",
        "web/source/lib/value.ts": "export const value = 1;",
      },
      rootNames: ["web/source/main.ts"],
      options: configOptions(configRoot, { baseUrl: "../source", noLib: true }),
    });
    const host = captured.hosts.at(-1)!;
    expect(host.getCurrentDirectory()).toBe(aliasBase);
    expect(host.fileExists("lib/value.ts")).toBe(true);
    expect(host.readFile("lib/value.ts")).toBe("export const value = 1;");
    expect(host.directoryExists?.("lib")).toBe(true);
    expect(host.realpath?.("lib/value.ts")).toBe(
      path.join(aliasBase, "lib/value.ts"),
    );
    expect(host.readDirectory?.("lib", [".ts"], [], ["**/*"])).toEqual([
      path.join(aliasBase, "lib/value.ts"),
    ]);
    const relativePackage = path.relative(aliasBase, target);
    expect(host.fileExists(relativePackage)).toBe(true);
    expect(host.readFile(relativePackage)).toContain("ReactNode");
    expect(host.realpath?.(relativePackage)).toBe(
      dependencies.realpath(target),
    );
    expect(
      host.getDirectories?.(path.dirname(relativePackage)) ?? [],
    ).toContain("ts5.0");
    expect(
      (host.getDirectories?.(path.dirname(relativePackage)) ?? []).every(
        (entry) => !path.isAbsolute(entry),
      ),
    ).toBe(true);
    expect(dependencies.manifest()).toBeDefined();
  });

  it("uses each referenced project's own alias base", async () => {
    const fixture = await createInspectionFixture();
    const repositoryRoot = path.join(fixture.root, "repository");
    const target = await installedReact(repositoryRoot);
    const snapshotRoot = path.join(fixture.root, "snapshot");
    const files = {
      "apps/one/tsconfig.json": JSON.stringify({
        compilerOptions: {
          composite: true,
          noLib: true,
          types: [],
          paths: { "@/*": ["./*"] },
        },
        files: ["main.ts"],
      }),
      "apps/one/main.ts": "export const one = 1;",
      "packages/two/tsconfig.json": JSON.stringify({
        compilerOptions: {
          composite: true,
          noLib: true,
          types: [],
          paths: { "@/*": ["./*"] },
        },
        files: ["source/main.ts"],
      }),
      "packages/two/source/main.ts": "export const two = 2;",
    };
    const dependencies = new CapturedDependencies({
      repositoryRoot,
      snapshots: { baselineDir: snapshotRoot, targetDir: snapshotRoot },
    });
    const probes = vi.spyOn(dependencies, "fileExists");
    const result = createSnapshotProgram({
      repositoryRoot,
      snapshotRoot,
      dependencies,
      files,
      rootNames: [],
      options: configOptions(path.join(snapshotRoot, "root"), { noLib: true }),
      projectReferences: [
        { path: path.join(snapshotRoot, "apps/one") },
        { path: path.join(snapshotRoot, "packages/two") },
      ],
    });
    expect(result.programs).toHaveLength(3);
    for (const [index, projectPath] of ["apps/one", "packages/two"].entries()) {
      const program = result.programs[index + 1]!;
      const host = captured.hosts[index + 1]!;
      const base = path.join(snapshotRoot, projectPath);
      probes.mockClear();
      moduleSpecifiers.getLocalModuleSpecifierBetweenFileNames(
        program.getSourceFiles()[0]!,
        target,
        program.getCompilerOptions(),
        {
          ...host,
          getDefaultResolutionModeForFile: () => ts.ModuleKind.ESNext,
        },
        {},
      );
      expect(probes.mock.calls.length).toBeGreaterThan(0);
      expect(probes.mock.calls.map(([probe]) => probe)).toContain(
        path.resolve(path.dirname(target), "../react.ts"),
      );
      expect(host.getCurrentDirectory()).toBe(base);
    }
    expect(dependencies.manifest()).toBeDefined();
  });
  it("preserves conflicting installed type diagnostics across snapshots and cwd", async () => {
    const fixture = await createInspectionFixture();
    const repositoryRoot = path.join(fixture.root, "repository");
    const reactDeclaration = await installedReact(repositoryRoot);
    await fixture.write(
      "repository/web/node_modules/widget/index.d.ts",
      'export declare const node: import("react").ReactElement;',
    );
    // Two incompatible declarations force external import() type names in 2322.
    await fixture.write(
      "repository/web/node_modules/widget/node_modules/@types/react/index.d.ts",
      (await fs.readFile(reactDeclaration, "utf8")).replaceAll(
        "key: string | null",
        "key: number | null",
      ),
    );
    const roots = {
      baselineDir: path.join(fixture.root, "baseline"),
      targetDir: path.join(fixture.root, "deep/snapshots/target"),
    };
    let expected: unknown;
    const manifests = new Map<string, unknown>();
    for (const cwd of [
      repositoryRoot,
      path.join(repositoryRoot, "web"),
      path.join(fixture.root, "driver"),
    ]) {
      vi.spyOn(process, "cwd").mockReturnValue(cwd);
      for (const snapshotRoot of Object.values(roots)) {
        const dependencies = new CapturedDependencies({
          repositoryRoot,
          snapshots: roots,
        });
        const result = createSnapshotProgram({
          repositoryRoot,
          snapshotRoot,
          dependencies,
          files: {
            "web/main.ts":
              'import { node } from "widget"; import type { ReactElement } from "react"; const value: ReactElement = node;',
          },
          rootNames: ["web/main.ts"],
          options: configOptions(path.join(snapshotRoot, "web"), {
            module: "nodenext",
            moduleResolution: "nodenext",
            skipLibCheck: true,
            strict: true,
          }),
        });
        const diagnostics = result.program
          .getSemanticDiagnostics()
          .map((item) => ({
            code: item.code,
            file: path.relative(snapshotRoot, item.file!.fileName),
            message: ts.flattenDiagnosticMessageText(item.messageText, " "),
          }));
        expect(diagnostics.map((item) => item.code)).toEqual([2322]);
        expect(diagnostics[0]!.message).toContain("import(");
        expect(diagnostics[0]!.message).toContain("ReactElement");
        expected ??= diagnostics;
        expect(diagnostics).toEqual(expected);
        const manifest = dependencies.manifest();
        expect(manifest).toBeDefined();
        if (manifests.has(snapshotRoot))
          expect(manifest).toEqual(manifests.get(snapshotRoot));
        else manifests.set(snapshotRoot, manifest);
      }
    }
  });

  it.each([true, false])(
    "uses a deterministic project directory without aliases (config: %s)",
    (configured) => {
      const snapshotRoot = path.resolve("/virtual/snapshot");
      const base = configured ? path.join(snapshotRoot, "web") : snapshotRoot;
      createSnapshotProgram({
        repositoryRoot: path.resolve("/virtual/repository"),
        snapshotRoot,
        files: { [configured ? "web/main.ts" : "main.ts"]: "export {};" },
        rootNames: [],
        options: {
          noLib: true,
          types: [],
          ...(configured
            ? { configFilePath: path.join(base, "tsconfig.json") }
            : {}),
        },
      });
      const host = captured.hosts.at(-1)!;
      expect(host.getCurrentDirectory()).toBe(base);
      expect(host.fileExists("main.ts")).toBe(true);
      expect(host.readFile("main.ts")).toBe("export {};");
    },
  );

  it("honors an inherited paths base distinct from the selected config directory", () => {
    const snapshotRoot = path.resolve("/virtual/snapshot");
    const base = path.join(snapshotRoot, "shared-config");
    createSnapshotProgram({
      repositoryRoot: path.resolve("/virtual/repository"),
      snapshotRoot,
      files: { "shared-config/local.ts": "export {};" },
      rootNames: [],
      options: {
        ...configOptions(base, { noLib: true }),
        configFilePath: path.join(snapshotRoot, "web/config/tsconfig.json"),
      },
    });
    const host = captured.hosts.at(-1)!;
    expect(host.getCurrentDirectory()).toBe(base);
    expect(host.fileExists("local.ts")).toBe(true);
  });

  it("still rejects live source, outside files, and installed links escaping into source", async () => {
    const fixture = await createInspectionFixture();
    const repositoryRoot = path.join(fixture.root, "repository");
    await fixture.write("repository/web/live.ts", "export const live = 1;");
    await fixture.write("outside/index.d.ts", "export const outside: number;");
    await fixture.symlink(
      path.join(fixture.root, "outside"),
      "repository/web/node_modules/escape",
    );
    await fixture.symlink(
      path.join(repositoryRoot, "web/live.ts"),
      "repository/web/node_modules/live/index.d.ts",
    );
    const snapshotRoot = path.join(fixture.root, "snapshot");
    const base = path.join(snapshotRoot, "web");
    const dependencies = new CapturedDependencies({ repositoryRoot });
    createSnapshotProgram({
      repositoryRoot,
      snapshotRoot,
      dependencies,
      files: { "web/main.ts": "export {};" },
      rootNames: ["web/main.ts"],
      options: configOptions(base, { noLib: true }),
    });
    const host = captured.hosts.at(-1)!;
    for (const candidate of [
      path.join(repositoryRoot, "web/live.ts"),
      path.join(fixture.root, "outside/index.d.ts"),
      path.join(repositoryRoot, "web/node_modules/escape/index.d.ts"),
      path.join(repositoryRoot, "web/node_modules/live/index.d.ts"),
    ]) {
      const probe = path.relative(base, candidate);
      expect(host.fileExists(probe)).toBe(false);
      expect(host.readFile(probe)).toBeUndefined();
    }
    expect(dependencies.manifest()).toBeUndefined();
  });
});
