import { describe, expect, it, onTestFinished } from "vitest";
import { dirname, join, resolve } from "node:path";
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { execa } from "execa";
import { parse as parseYaml } from "yaml";
import {
  releaseReadiness,
  verificationSteps,
} from "../../scripts/release-check.mjs";
import * as releaseCheck from "../../scripts/release-check.mjs";
import {
  assertAllowedPackageFiles,
  assertPackMetadata,
} from "../../scripts/check-package-contents.mjs";
import {
  assertReleaseBaseScanReport,
  releaseArtifactFilename,
} from "../../scripts/prepare-release-artifact.mjs";

const root = resolve(import.meta.dirname, "../..");

describe("release verification contract", () => {
  it("runs npm through its JavaScript entry point without a command shell", () => {
    const commandInvocation = (
      releaseCheck as unknown as {
        commandInvocation?: (
          command: string,
          args: readonly string[],
          options: { npmCliPath: string; nodeExecutable: string },
        ) => { executable: string; args: readonly string[] };
      }
    ).commandInvocation;

    expect(commandInvocation).toBeTypeOf("function");
    if (commandInvocation === undefined) return;
    expect(
      commandInvocation("npm", ["run", "typecheck"], {
        npmCliPath: "C:\\npm\\npm-cli.js",
        nodeExecutable: "C:\\node\\node.exe",
      }),
    ).toEqual({
      executable: "C:\\node\\node.exe",
      args: ["C:\\npm\\npm-cli.js", "run", "typecheck"],
    });
  });

  it.each(["/tmp/yarn.js", "/tmp/pnpm.cjs", process.execPath])(
    "ignores a non-npm lifecycle executable: %s",
    (npmExecPath) => {
      const resolveNpmCliPath = (
        releaseCheck as unknown as {
          resolveNpmCliPath: (options: { npmExecPath: string }) => string;
        }
      ).resolveNpmCliPath;

      expect(resolveNpmCliPath({ npmExecPath })).toMatch(
        /[\\/]npm[\\/]bin[\\/]npm-cli\.js$/u,
      );
    },
  );

  it("accepts npm's versioned Volta installation layout", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "zedbee-volta-npm-"));
    onTestFinished(() => rm(temporaryRoot, { recursive: true, force: true }));
    const npmRoot = join(
      temporaryRoot,
      ".volta",
      "tools",
      "image",
      "npm",
      "11.6.3",
    );
    const npmCliPath = join(npmRoot, "bin", "npm-cli.js");
    await mkdir(dirname(npmCliPath), { recursive: true });
    await writeFile(
      join(npmRoot, "package.json"),
      '{"name":"npm","version":"11.6.3"}\n',
    );
    await writeFile(npmCliPath, "process.exitCode = 0;\n");
    const resolveNpmCliPath = (
      releaseCheck as unknown as {
        resolveNpmCliPath: (options: {
          nodeExecutable: string;
          npmExecPath: string;
          pathValue: string;
        }) => string;
      }
    ).resolveNpmCliPath;

    const resolved = resolveNpmCliPath({
      nodeExecutable: join(temporaryRoot, "node"),
      npmExecPath: npmCliPath,
      pathValue: "",
    });
    expect(await realpath(resolved)).toBe(await realpath(npmCliPath));
  });

  it("builds once before running every release-safety gate", () => {
    expect(verificationSteps("verify")).toEqual([
      { id: "build", command: "npm", args: ["run", "build"] },
      { id: "typecheck", command: "npm", args: ["run", "typecheck"] },
      {
        id: "tests",
        command: "node",
        args: ["node_modules/vitest/vitest.mjs", "run"],
      },
      {
        id: "schema",
        command: "node",
        args: ["dist/config/json-schema.js", "--check"],
      },
      { id: "licenses", command: "npm", args: ["run", "licenses:check"] },
      {
        id: "benchmark",
        command: "node",
        args: ["--experimental-strip-types", "bench/run.mts"],
      },
      {
        id: "package",
        command: "node",
        args: ["scripts/check-package-contents.mjs"],
      },
      {
        id: "diff",
        command: "git",
        args: ["--no-pager", "diff", "--check"],
      },
    ]);
  });

  it("verifies a fresh project whose typecheck imports generated build output", async () => {
    const fixture = await mkdtemp(join(tmpdir(), "zedbee-clean-verify-"));
    onTestFinished(() =>
      rm(fixture, { recursive: true, force: true }).catch(() => {}),
    );
    await execa("git", ["init", "--initial-branch=main"], { cwd: fixture });
    for (const directory of [
      "src",
      "scripts",
      "bench",
      "node_modules/vitest",
    ]) {
      await mkdir(join(fixture, directory), { recursive: true });
    }
    const compiler = join(root, "node_modules/typescript/bin/tsc");
    await writeFile(
      join(fixture, "package.json"),
      JSON.stringify({
        name: "clean-verification-fixture",
        private: true,
        type: "module",
        scripts: {
          build: "node build.mjs",
          typecheck: `node ${JSON.stringify(compiler)} --noEmit`,
          "licenses:check": "node scripts/check-package-contents.mjs",
        },
      }),
    );
    await writeFile(
      join(fixture, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { module: "NodeNext", strict: true, types: [] },
        include: ["src/**/*.ts"],
      }),
    );
    await writeFile(
      join(fixture, "src/index.ts"),
      'import { value } from "../dist/generated.js"; export const result: number = value;\n',
    );
    await writeFile(
      join(fixture, "build.mjs"),
      [
        'import { mkdirSync, writeFileSync } from "node:fs";',
        'mkdirSync("dist/config", { recursive: true });',
        'writeFileSync("dist/generated.js", "export const value = 1;\\n");',
        'writeFileSync("dist/generated.d.ts", "export declare const value: number;\\n");',
        'writeFileSync("dist/config/json-schema.js", "export {};\\n");',
      ].join("\n"),
    );
    for (const file of [
      "scripts/check-package-contents.mjs",
      "bench/run.mts",
      "node_modules/vitest/vitest.mjs",
    ]) {
      await writeFile(join(fixture, file), "export {};\n");
    }
    const result = await execa(
      process.execPath,
      [join(root, "scripts/release-check.mjs"), "--verify"],
      { cwd: fixture, reject: false },
    );
    expect(result.exitCode, result.stderr || result.stdout).toBe(0);
    expect(result.stdout).toContain("Local verification passed.");
  });

  it("disables Git's pager for diff verification", () => {
    expect(verificationSteps("verify").find(({ id }) => id === "diff")).toEqual(
      {
        id: "diff",
        command: "git",
        args: ["--no-pager", "diff", "--check"],
      },
    );
  });

  it("blocks release while the package still has placeholder publication identity", () => {
    expect(releaseReadiness({ name: "zedbee", version: "0.0.0" }, [])).toEqual({
      ready: false,
      message:
        "Release blocked: package name, version, access, and registry must identify the public zedbee release.",
    });
  });

  it("accepts HTTPS metadata only when it identifies a configured Git remote", () => {
    expect(
      releaseReadiness(
        {
          name: "zedbee",
          version: "0.1.0",
          publishConfig: {
            access: "public",
            registry: "https://registry.npmjs.org/",
          },
          repository: { url: "https://github.com/owner/zedbee.git" },
          homepage: "https://github.com/owner/zedbee#readme",
          bugs: { url: "https://github.com/owner/zedbee/issues" },
        },
        ["git@github.com:owner/zedbee.git"],
      ),
    ).toEqual({ ready: true });
  });

  it.each([
    {
      repository: "https://github.com/owner/zedbee.evil",
      homepage: "https://github.com/owner/zedbee.evil#readme",
      bugs: "https://github.com/owner/zedbee.evil/issues",
      remote: "git@github.com:owner/zedbee.git",
    },
    {
      repository: "https://github.com/owner/zedbee",
      homepage: "https://github.com.evil/owner/zedbee#readme",
      bugs: "https://github.com/owner/zedbee/issues",
      remote: "git@github.com:owner/zedbee.git",
    },
    {
      repository: "https://github.com/owner/zedbee",
      homepage: "https://github.com/owner/zedbee.evil#readme",
      bugs: "https://github.com/owner/zedbee/issues",
      remote: "git@github.com:owner/zedbee.git",
    },
    {
      repository: "https://github.com/owner/zedbee",
      homepage: "https://github.com/owner/zedbee#readme",
      bugs: "https://github.com/owner/zedbee-security",
      remote: "git@github.com:owner/zedbee.git",
    },
  ])(
    "rejects repository siblings and lookalike origins: $homepage",
    ({ repository, homepage, bugs, remote }) => {
      expect(
        releaseReadiness(
          {
            name: "zedbee",
            version: "0.1.0",
            publishConfig: {
              access: "public",
              registry: "https://registry.npmjs.org/",
            },
            repository: { url: repository },
            homepage,
            bugs: { url: bugs },
          },
          [remote],
        ),
      ).toMatchObject({ ready: false });
    },
  );

  it("packs and inspects the Node-native core package", async () => {
    const environment = { ...process.env };
    delete environment.npm_execpath;
    const result = await execa(
      process.execPath,
      [resolve(root, "scripts/check-package-contents.mjs")],
      {
        cwd: root,
        env: environment,
        extendEnv: false,
        reject: false,
        stdin: "ignore",
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("Core package contents passed.");
  });

  it.each([
    "docs/superpowers/plans/private.md",
    "PRODUCT.md",
    "test/fixture.ts",
    "src/internal.ts",
    "dist/unexpected-private-note.md",
    "dist/unexpected.js",
  ])("rejects an unapproved package path: %s", (unapproved) => {
    expect(() =>
      assertAllowedPackageFiles(["package.json", unapproved], {
        sourcePaths: ["src/index.ts"],
        reviewedOverridePaths: [],
      }),
    ).toThrow(/unapproved files/u);
  });

  it("accepts only declared public assets and source-derived build outputs", () => {
    expect(() =>
      assertAllowedPackageFiles(
        [
          "package.json",
          "README.md",
          "LICENSE",
          "THIRD_PARTY_NOTICES.md",
          "docs/support.md",
          "docs/reporting.md",
          "schema/zedbee.schema.json",
          "licenses/production-inventory.json",
          "licenses/reviewed-overrides.json",
          "licenses/reviewed-obligations.json",
          "licenses/overrides/example-LICENSE",
          "dist/index.js",
          "dist/index.js.map",
          "dist/index.d.ts",
          "dist/index.d.ts.map",
        ],
        {
          sourcePaths: ["src/index.ts"],
          reviewedOverridePaths: ["licenses/overrides/example-LICENSE"],
        },
      ),
    ).not.toThrow();
  });

  it("rejects bundled dependencies and mismatched pack identity", () => {
    expect(() =>
      assertPackMetadata(
        JSON.stringify([
          { name: "zedbee", version: "0.1.0", bundled: ["eslint"] },
        ]),
        "0.1.0",
      ),
    ).toThrow(/bundled dependencies/u);
    expect(() =>
      assertPackMetadata(
        JSON.stringify([{ name: "zedbee", version: "0.1.1", bundled: [] }]),
        "0.1.0",
      ),
    ).toThrow(/identity/u);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a package whose CLI entrypoint is not executable",
    () => {
      expect(() =>
        assertPackMetadata(
          JSON.stringify([
            {
              name: "zedbee",
              version: "0.1.0",
              bundled: [],
              files: [{ path: "dist/cli.js", mode: 0o644 }],
            },
          ]),
          "0.1.0",
        ),
      ).toThrow(/CLI entrypoint must be executable/u);
    },
  );

  it("accepts only the canonical tarball emitted for the release manifest", () => {
    expect(
      releaseArtifactFilename(
        JSON.stringify([
          { name: "zedbee", version: "0.1.0", filename: "zedbee-0.1.0.tgz" },
        ]),
        { name: "zedbee", version: "0.1.0" },
      ),
    ).toBe("zedbee-0.1.0.tgz");

    for (const output of [
      JSON.stringify([
        { name: "zedbee", version: "0.1.0", filename: "../escape.tgz" },
      ]),
      JSON.stringify([
        { name: "other", version: "0.1.0", filename: "other-0.1.0.tgz" },
      ]),
      JSON.stringify([
        { name: "zedbee", version: "0.1.1", filename: "zedbee-0.1.1.tgz" },
      ]),
    ]) {
      expect(() =>
        releaseArtifactFilename(output, {
          name: "zedbee",
          version: "0.1.0",
        }),
      ).toThrow(/release artifact/u);
    }
  });

  it("requires the release smoke scan to block one committed base-mode file", () => {
    expect(() =>
      assertReleaseBaseScanReport(
        {
          mode: "base",
          baseline: "base-oid",
          target: "target-oid",
          requestedBase: "base-oid",
          changedFileCount: 1,
          outcome: "blocked",
          exitCode: 1,
          checks: [
            {
              checkId: "formatting",
              findings: [{ location: { file: "branch.ts" } }],
            },
          ],
        },
        { baseline: "base-oid", target: "target-oid" },
      ),
    ).not.toThrow();

    for (const invalid of [
      { mode: "index" },
      { baseline: "other-base" },
      { target: "other-target" },
      { requestedBase: "other-base" },
      { changedFileCount: 0 },
      { outcome: "pass" },
      { exitCode: 0 },
      { checks: [] },
      {
        checks: [
          {
            checkId: "lint",
            findings: [{ location: { file: "branch.ts" } }],
          },
        ],
      },
      {
        checks: [
          {
            checkId: "formatting",
            findings: [{ location: { file: "other.ts" } }],
          },
        ],
      },
    ]) {
      expect(() =>
        assertReleaseBaseScanReport(
          {
            mode: "base",
            baseline: "base-oid",
            target: "target-oid",
            requestedBase: "base-oid",
            changedFileCount: 1,
            outcome: "blocked",
            exitCode: 1,
            checks: [
              {
                checkId: "formatting",
                findings: [{ location: { file: "branch.ts" } }],
              },
            ],
            ...invalid,
          },
          { baseline: "base-oid", target: "target-oid" },
        ),
      ).toThrow(/committed base-mode smoke scan/u);
    }
  });

  it.each([
    { name: "ci.yml", triggers: { workflow_dispatch: null } },
    {
      name: "release-check.yml",
      triggers: { workflow_dispatch: null, push: { tags: ["v*"] } },
    },
  ])(
    "keeps $name off pull requests and branch pushes",
    async ({ name, triggers }) => {
      const workflow = parseYaml(
        await readFile(resolve(root, ".github/workflows", name), "utf8"),
      ) as { on: unknown };

      expect(workflow.on).toEqual(triggers);
    },
  );

  it("uploads the smoke-tested tarball without publishing it", async () => {
    const workflow = await readFile(
      resolve(root, ".github/workflows/release-check.yml"),
      "utf8",
    );
    const prepare = workflow.indexOf("npm run artifact:prepare");
    const upload = workflow.search(
      /uses:\s+actions\/upload-artifact@[0-9a-f]{40}\s+# v\d+\.\d+\.\d+/u,
    );

    expect(prepare).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(prepare);
    expect(workflow).toContain("release-artifacts/*.tgz");
    expect(workflow).not.toMatch(/npm\s+publish/u);
  });

  it("pins every external workflow action to a reviewed commit", async () => {
    const workflowsDirectory = resolve(root, ".github/workflows");
    const workflowNames = (await readdir(workflowsDirectory)).filter((name) =>
      /\.ya?ml$/u.test(name),
    );
    const references: string[] = [];

    const collectUses = (value: unknown): void => {
      if (Array.isArray(value)) {
        for (const item of value) collectUses(item);
        return;
      }
      if (value === null || typeof value !== "object") return;
      for (const [key, nested] of Object.entries(value)) {
        if (key === "uses") {
          expect(nested).toBeTypeOf("string");
          if (typeof nested === "string") references.push(nested);
        } else {
          collectUses(nested);
        }
      }
    };

    for (const workflowName of workflowNames) {
      const workflow = await readFile(
        resolve(workflowsDirectory, workflowName),
        "utf8",
      );
      collectUses(parseYaml(workflow));
    }

    expect(references.length).toBeGreaterThan(0);
    for (const action of references.filter(
      (reference) => !reference.startsWith("./"),
    )) {
      expect(action).toMatch(/^[^@\s]+@[0-9a-f]{40}$/u);
    }
  });
});
