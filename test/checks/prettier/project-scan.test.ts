import {
  cp,
  mkdir,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, onTestFinished } from "vitest";
import { GitClient } from "../../../src/git/client.js";
import {
  readStagedChangeSet,
  type ChangeSet,
} from "../../../src/git/change-set.js";
import { buildSnapshotPair } from "../../../src/git/snapshot.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { resolveConfig } from "../../../src/config/profiles.js";
import type { ResolvedConfig } from "../../../src/config/schema.js";
import { prettierAdapter } from "../../../src/checks/prettier/adapter.js";
import { PROJECT_FORMAT_SOURCE_MAX_BYTES } from "../../../src/checks/prettier/project-protocol.js";
import { persistProjectPrettierTrust } from "../../../src/checks/prettier/project-trust.js";
import { createGitRepository } from "../../helpers/git-repository.js";
import { testFilePolicyResolver } from "../../helpers/file-policy.js";

const repositoryPackageRoot = fileURLToPath(
  new URL("../../../", import.meta.url),
);

const FIXTURE_PLUGIN = `export const languages = [
  { name: "Fixture", parsers: ["fixture"], extensions: [".fixturetxt"] },
];
export const parsers = {
  fixture: {
    parse: (text) => text,
    astFormat: "fixture-ast",
    locStart: () => 0,
    locEnd: (node) => node.length,
  },
};
export const printers = {
  "fixture-ast": { print: () => "FIXTURE\\n" },
};
`;

async function scanFixture(
  options: {
    plugin?: boolean;
    ignore?: string;
  } = {},
) {
  const repository = await createGitRepository("zedbee-project-scan-");
  await repository.write(
    "package.json",
    `${JSON.stringify({
      name: "project-scan-fixture",
      private: true,
      ...(options.plugin === true
        ? {
            workspaces: ["packages/*"],
            devDependencies: {
              prettier: "^3.0.0",
              "fixture-plugin": "*",
            },
          }
        : { devDependencies: { prettier: "^3.0.0" } }),
    })}\n`,
  );
  await mkdir(join(repository.root, "node_modules"), { recursive: true });
  await cp(
    join(repositoryPackageRoot, "node_modules", "prettier"),
    join(repository.root, "node_modules", "prettier"),
    { recursive: true },
  );
  await repository.write(
    ".prettierrc.json",
    options.plugin === true
      ? '{"plugins":["fixture-plugin"]}'
      : '{\n  "singleQuote": true\n}\n',
  );
  if (options.plugin === true) {
    await repository.write(
      "packages/fixture-plugin/package.json",
      '{"name":"fixture-plugin","version":"1.0.0","type":"module","main":"index.mjs"}',
    );
    await repository.write("packages/fixture-plugin/index.mjs", FIXTURE_PLUGIN);
    await symlink(
      join(repository.root, "packages", "fixture-plugin"),
      join(repository.root, "node_modules", "fixture-plugin"),
      "dir",
    );
  }
  if (options.ignore !== undefined) {
    await repository.write(".prettierignore", options.ignore);
  }
  await repository.git(["add", "--all"]);
  const commit = await repository.git([
    "commit",
    "--message",
    "base",
    "--no-verify",
  ]);
  if (commit.exitCode !== 0) throw new Error(commit.stderr);
  return repository;
}

async function runScan(
  repository: Awaited<ReturnType<typeof createGitRepository>>,
  options: {
    config: ResolvedConfig;
    invocationTrust?: boolean;
  },
) {
  const git = new GitClient(repository.root);
  const changeSet: ChangeSet = await readStagedChangeSet(git);
  const snapshots = await buildSnapshotPair(repository.root, git);
  onTestFinished(snapshots.cleanup);
  return prettierAdapter.runLegacy({
    repositoryRoot: repository.root,
    changeSet,
    config: options.config,
    snapshots,
    baselineInspection: await inspectRepository(snapshots.baselineDir),
    targetInspection: await inspectRepository(snapshots.targetDir),
    target: { id: ".", kind: "repository", relativeRoot: "." },
    policy: options.config.checks.formatting,
    policyForFile: testFilePolicyResolver(options.config),
    ...(options.invocationTrust === true ? { projectPrettierTrust: true } : {}),
    signal: new AbortController().signal,
  });
}

function projectConfig(): ResolvedConfig {
  return resolveConfig({
    schemaVersion: 1,
    profile: "recommended",
    checks: { formatting: { engine: "project" } },
  });
}

describe("project Prettier scan integration", () => {
  it("uses the project formatter and attributes staged lines", async () => {
    const repository = await scanFixture();
    await repository.write("passed.ts", "export const value = 'ok';\n");
    await persistProjectPrettierTrust(repository.root, ".");
    await repository.write("passed.ts", "export const value = 'ok';\n");
    await repository.write("failed.ts", 'export const value = "no";\n');
    await repository.git(["add", "--", "passed.ts", "failed.ts"]);

    const result = await runScan(repository, { config: projectConfig() });

    expect(result.status).toBe("completed");
    expect(result.findings.map((finding) => finding.location)).toEqual([
      { file: "failed.ts", startLine: 1, endLine: 1 },
    ]);
    expect(result.findings[0]?.message).toMatch(/this project's Prettier/u);
    expect(result.formattingProvenance).toEqual([
      {
        engine: "project",
        version: "3.9.6",
        projectRoot: ".",
        configFiles: [".prettierrc.json"],
      },
    ]);
  });

  it("reports only the native configuration selected for checked files", async () => {
    const repository = await scanFixture();
    await repository.write("src/.prettierrc.json", '{"semi":false}');
    await repository.write("src/value.ts", "export const value = 'ok'\n");
    await repository.git(["add", "--", "src/.prettierrc.json", "src/value.ts"]);
    await persistProjectPrettierTrust(repository.root, ".");

    const result = await runScan(repository, { config: projectConfig() });

    expect(result.status).toBe("completed");
    expect(result.formattingProvenance).toEqual([
      {
        engine: "project",
        version: "3.9.6",
        projectRoot: ".",
        configFiles: ["src/.prettierrc.json"],
      },
    ]);
  });

  it("accepts invocation-only trust without stored consent", async () => {
    const repository = await scanFixture();
    await repository.write("value.ts", 'export const value = "hello";\n');
    await repository.git(["add", "--", "value.ts"]);

    const result = await runScan(repository, {
      config: projectConfig(),
      invocationTrust: true,
    });

    expect(result.status).toBe("completed");
    expect(result.findings.map((finding) => finding.location?.file)).toEqual([
      "value.ts",
    ]);
  });

  it("reports an incomplete formatting check when trust is missing", async () => {
    const repository = await scanFixture();
    await repository.write("failed.ts", 'export const value = "no";\n');
    await repository.git(["add", "--", "failed.ts"]);

    const result = await runScan(repository, {
      config: projectConfig(),
    });

    expect(result.status).toBe("incomplete");
    expect(result).toMatchObject({
      error: { code: "PROJECT_PRETTIER_TRUST_REQUIRED" },
    });
  });

  it("formats plugin-only extensions and reports an incomplete check for missing plugins", async () => {
    const repository = await scanFixture({ plugin: true });
    await repository.write("value.fixturetxt", "anything");
    await repository.git(["add", "--", "value.fixturetxt"]);

    const pluginResult = await runScan(repository, {
      config: projectConfig(),
      invocationTrust: true,
    });

    expect(pluginResult.status).toBe("completed");
    expect(pluginResult.findings.map((finding) => finding.location)).toEqual([
      { file: "value.fixturetxt", startLine: 1, endLine: 1 },
    ]);

    // Removing the plugin from the configuration makes the next scan incomplete
    // rather than silently falling back to managed formatting.
    const broken = await scanFixture({ plugin: true });
    await broken.write(".prettierrc.json", '{"plugins":["missing-plugin"]}');
    await broken.write("value.fixturetxt", "anything");
    await broken.git(["add", "--", ".prettierrc.json", "value.fixturetxt"]);

    const missingResult = await runScan(broken, {
      config: projectConfig(),
      invocationTrust: true,
    });

    expect(missingResult.status).toBe("incomplete");
    expect(missingResult).toMatchObject({
      error: { code: "PROJECT_PRETTIER_PLUGIN_MISSING" },
    });
  });

  it("keeps ignored files distinguishable from checked files", async () => {
    const repository = await scanFixture({
      ignore: "ignored.ts\n!included.ts\n",
    });
    await repository.write("ignored.ts", 'export const value = "no";\n');
    await repository.write("included.ts", 'export const value = "no";\n');
    await repository.git(["add", "--", "ignored.ts", "included.ts"]);

    const result = await runScan(repository, {
      config: projectConfig(),
      invocationTrust: true,
    });

    expect(result.status).toBe("completed");
    expect(result.findings.map((finding) => finding.location?.file)).toEqual([
      "included.ts",
    ]);
    expect(result.findings[0]?.location?.file).not.toBe("ignored.ts");
    expect(result).toMatchObject({
      formattingCoverage: {
        checkedFiles: 1,
        ignoredFiles: 1,
        unsupportedFiles: 0,
      },
    });
  });

  it("reports an all-ignored run as skipped instead of checked-and-passed", async () => {
    const repository = await scanFixture({ ignore: "generated/**\n" });
    await repository.write(
      "generated/value.ts",
      'export const value = "no";\n',
    );
    await repository.git(["add", "--", "generated/value.ts"]);

    const result = await runScan(repository, {
      config: projectConfig(),
      invocationTrust: true,
    });

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toMatch(/ignored or unsupported/u);
    expect(result.formattingCoverage).toEqual({
      checkedFiles: 0,
      ignoredFiles: 1,
      unsupportedFiles: 0,
    });
    expect(result.findings).toEqual([]);
  });

  it("classifies an unsupported large file before loading its contents", async () => {
    const repository = await scanFixture();
    await writeFile(
      join(repository.root, "asset.bin"),
      "x".repeat(PROJECT_FORMAT_SOURCE_MAX_BYTES + 1),
    );
    await repository.git(["add", "--", "asset.bin"]);

    const result = await runScan(repository, {
      config: projectConfig(),
      invocationTrust: true,
    });

    expect(result.status).toBe("skipped");
    expect(result.skipReason).toMatch(/ignored or unsupported/u);
    expect(result.formattingCoverage).toEqual({
      checkedFiles: 0,
      ignoredFiles: 0,
      unsupportedFiles: 1,
    });
  });

  it("reports a supported file that exceeds the project source limit", async () => {
    const repository = await scanFixture();
    await writeFile(
      join(repository.root, "large.ts"),
      `// ${"x".repeat(PROJECT_FORMAT_SOURCE_MAX_BYTES)}`,
    );
    await repository.git(["add", "--", "large.ts"]);

    const result = await runScan(repository, {
      config: projectConfig(),
      invocationTrust: true,
    });

    expect(result).toMatchObject({
      status: "incomplete",
      error: {
        code: "PROJECT_PRETTIER_OUTPUT_LIMIT",
        path: "large.ts",
      },
    });
  });

  it("routes each workspace through its own project formatter", async () => {
    const repository = await createGitRepository("zedbee-project-scan-multi-");
    await repository.write(
      "package.json",
      '{"name":"root","private":true,"workspaces":["web","app"]}',
    );
    await repository.write(
      "web/package.json",
      '{"name":"web","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write("web/.prettierrc.json", '{"singleQuote":true}');
    await repository.write(
      "app/package.json",
      '{"name":"app","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write("app/.prettierrc.json", '{"printWidth":20}');
    await mkdir(join(repository.root, "node_modules"), { recursive: true });
    await cp(
      join(repositoryPackageRoot, "node_modules", "prettier"),
      join(repository.root, "node_modules", "prettier"),
      { recursive: true },
    );
    await repository.git(["add", "--all"]);
    const commit = await repository.git([
      "commit",
      "--message",
      "base",
      "--no-verify",
    ]);
    if (commit.exitCode !== 0) throw new Error(commit.stderr);
    await repository.write("web/value.ts", 'export const value = "web";\n');
    await repository.write(
      "app/value.ts",
      "export const value = sum(11111111, 22222222, 33333333);\n",
    );
    await repository.git(["add", "--", "web/value.ts", "app/value.ts"]);

    const config = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: { engine: "managed" } },
      overrides: [
        { files: ["web/**"], checks: { formatting: { engine: "project" } } },
        { files: ["app/**"], checks: { formatting: { engine: "project" } } },
      ],
    });
    const result = await runScan(repository, {
      config,
      invocationTrust: true,
    });

    expect(result.status).toBe("completed");
    expect(result.formattingProvenance).toEqual([
      {
        engine: "project",
        version: "3.9.6",
        projectRoot: "app",
        configFiles: ["app/.prettierrc.json"],
      },
      {
        engine: "project",
        version: "3.9.6",
        projectRoot: "web",
        configFiles: ["web/.prettierrc.json"],
      },
    ]);
    const files = result.findings.map((finding) => finding.location?.file);
    expect(files).toContain("web/value.ts");
    expect(files).toContain("app/value.ts");
  });

  it("re-resolves the configuration between scans without reusing prior results", async () => {
    const repository = await scanFixture();
    await repository.write("value.ts", 'export const value = "hello";\n');
    await repository.git(["add", "--", "value.ts"]);

    const first = await runScan(repository, {
      config: projectConfig(),
      invocationTrust: true,
    });
    expect(first.status).toBe("completed");
    expect(first.findings).toHaveLength(1);

    // Staging a configuration change must affect the very next scan; project
    // results are never persisted or reused across scans.
    await repository.write(
      ".prettierrc.json",
      '{\n  "singleQuote": false\n}\n',
    );
    await repository.git(["add", "--", ".prettierrc.json"]);

    const second = await runScan(repository, {
      config: projectConfig(),
      invocationTrust: true,
    });
    expect(second.status).toBe("completed");
    expect(second.findings).toEqual([]);
  });
});
