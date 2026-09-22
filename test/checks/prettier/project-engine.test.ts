import * as nativePrettier from "prettier";
import { cp, lstat, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { mkdtemp } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import {
  openProjectFormatter,
  resolveProjectPrettierInstallation,
} from "../../../src/checks/prettier/project-engine.js";
import { requireProjectPrettierTrust } from "../../../src/checks/prettier/project-trust.js";
import { createProjectPrettierFixture } from "../../helpers/project-prettier.js";
import { buildSnapshotPair } from "../../../src/git/snapshot.js";
import { GitClient } from "../../../src/git/client.js";
import { realpath } from "node:fs/promises";

const repositoryPackageRoot = fileURLToPath(
  new URL("../../..", import.meta.url),
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

describe("project Prettier engine", () => {
  it("classifies supported and unsupported paths without source content", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(".prettierrc.json", "{}");
    await fixture.write("value.ts", "export const value = 1;\n");
    await fixture.write("asset.bin", "not source\n");
    await fixture.stage(".prettierrc.json", "value.ts", "asset.bin");

    const session = await fixture.open({ source: "index", trust: true });

    await expect(session.classify("value.ts")).resolves.toEqual({
      kind: "supported",
    });
    await expect(session.classify("asset.bin")).resolves.toEqual({
      kind: "ignored",
      reason: "unsupported",
    });
  });

  it("honors an explicit parser for a file without an inferred parser", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      ".prettierrc.json",
      JSON.stringify({
        overrides: [{ files: "*.custom", options: { parser: "typescript" } }],
      }),
    );
    await fixture.write("value.custom", "const value=1");
    await fixture.stage(".prettierrc.json", "value.custom");

    const session = await fixture.open({ source: "index", trust: true });

    await expect(session.classify("value.custom")).resolves.toEqual({
      kind: "supported",
    });
    await expect(
      session.format("value.custom", "const value=1"),
    ).resolves.toEqual({
      kind: "formatted",
      text: "const value = 1;\n",
    });
  });

  it("uses index config rather than an unstaged edit", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(".prettierrc.json", '{"singleQuote":true}');
    await fixture.write("value.ts", 'export const value = "hello";\n');
    await fixture.stage(".prettierrc.json", "value.ts");
    await fixture.write(".prettierrc.json", '{"singleQuote":false}');

    const session = await fixture.open({ source: "index", trust: true });

    await expect(
      session.format("value.ts", 'export const value = "hello";'),
    ).resolves.toEqual({
      kind: "formatted",
      text: "export const value = 'hello';\n",
    });
  });

  it.each(["3.0.3", "3.9.6"])(
    "preserves a symlinked snapshot config with Prettier %s",
    async (prettierVersion) => {
      const fixture = await createProjectPrettierFixture({ prettierVersion });
      onTestFinished(() => fixture.dispose());
      await fixture.write("config.json", '{"singleQuote":true}');
      await symlink("config.json", join(fixture.root, ".prettierrc.json"));
      await fixture.write("value.ts", 'export const value = "hello";\n');
      await fixture.stage(".prettierrc.json", "config.json", "value.ts");
      await fixture.write("config.json", '{"singleQuote":false}');

      const session = await fixture.open({ source: "index", trust: true });

      await expect(session.classify("value.ts")).resolves.toEqual({
        kind: "supported",
      });
      await expect(
        session.format("value.ts", 'export const value = "hello";'),
      ).resolves.toEqual({
        kind: "formatted",
        text: "export const value = 'hello';\n",
      });
    },
  );

  it.each(["3.0.3", "3.9.6"])(
    "preserves EditorConfig numeric ranges without a config with Prettier %s",
    async (prettierVersion) => {
      const fixture = await createProjectPrettierFixture({ prettierVersion });
      onTestFinished(() => fixture.dispose());
      await fixture.write(
        ".editorconfig",
        "root = true\n[file{1..12}.ts]\nquote_type = single\n",
      );
      await fixture.write("file10.ts", 'export const value = "hello";\n');
      await fixture.write("file13.ts", 'export const value = "hello";\n');
      await fixture.stage(".editorconfig", "file10.ts", "file13.ts");

      const session = await fixture.open({ source: "index", trust: true });

      await expect(session.classify("file10.ts")).resolves.toEqual({
        kind: "supported",
      });
      await expect(
        session.format("file10.ts", 'export const value = "hello";'),
      ).resolves.toEqual({
        kind: "formatted",
        text: "export const value = 'hello';\n",
      });
      await expect(
        session.format("file13.ts", 'export const value = "hello";'),
      ).resolves.toEqual({
        kind: "formatted",
        text: 'export const value = "hello";\n',
      });
    },
  );

  it.each(["3.0.3", "3.9.6"])(
    "bounds native EditorConfig lookup above the mirror with Prettier %s",
    async (prettierVersion) => {
      const fixture = await createProjectPrettierFixture({ prettierVersion });
      onTestFinished(() => fixture.dispose());
      const outer = await mkdtemp(join(tmpdir(), "zedbee-editorconfig-parent-"));
      onTestFinished(() => rm(outer, { recursive: true, force: true }));
      await writeFile(
        join(outer, ".editorconfig"),
        "root = true\n[*]\nquote_type = single\n",
      );
      await fixture.write(".editorconfig", "[*]\nindent_style = space\n");
      await fixture.write("value.ts", 'export const value = "hello";\n');
      await fixture.stage(".editorconfig", "value.ts");
      // Place the owned mirror below an unrelated EditorConfig, without
      // writing to a shared temporary-directory ancestor.
      vi.stubEnv("TMPDIR", outer);
      vi.stubEnv("TMP", outer);
      vi.stubEnv("TEMP", outer);
      try {
        const session = await fixture.open({ source: "index", trust: true });
        await expect(
          session.format("value.ts", 'export const value = "hello";'),
        ).resolves.toEqual({
          kind: "formatted",
          text: 'export const value = "hello";\n',
        });
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it("does not execute a config without consent", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      "prettier.config.mjs",
      "import { writeFileSync } from 'node:fs';\n" +
        "writeFileSync(new URL('./MARKER_EXECUTED', import.meta.url), 'executed');\n" +
        "throw new Error('CONFIG_EXECUTED');\n",
    );
    await fixture.stage("prettier.config.mjs");

    await expect(
      fixture.open({ source: "index", trust: false }),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_TRUST_REQUIRED" });
    expect(await fixture.markerExists()).toBe(false);
  });

  it("committed inputs win over a conflicting staged config", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(".prettierrc.json", '{"singleQuote":true}');
    await fixture.write("value.ts", 'export const value = "hello";\n');
    await fixture.commit();
    await fixture.write(".prettierrc.json", '{"singleQuote":false}');
    await fixture.stage(".prettierrc.json");

    const session = await fixture.open({ source: "commit", trust: true });

    await expect(
      session.format("value.ts", 'export const value = "hello";'),
    ).resolves.toEqual({
      kind: "formatted",
      text: "export const value = 'hello';\n",
    });
  });

  it("does not substitute bundled formatting for a missing plugin", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      ".prettierrc.json",
      '{"plugins":["missing-fixture-plugin"]}',
    );
    await fixture.write("value.ts", "export const value = 1;\n");
    await fixture.stage(".prettierrc.json", "value.ts");

    const session = await fixture.open({ source: "index", trust: true });

    await expect(
      session.format("value.ts", "export const value = 1;"),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_PLUGIN_MISSING" });
  });

  it("retires its worker on close", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(".prettierrc.json", "{}");
    await fixture.write("value.ts", "export const value = 1;\n");
    await fixture.stage(".prettierrc.json", "value.ts");

    const session = await fixture.open({ source: "index", trust: true });
    await session.close();
    await expect(
      session.format("value.ts", "export const value = 1;"),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_WORKER_FAILED" });
  });

  it("imports representable values from a consented executable config", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      "prettier.config.mjs",
      "export default {" +
        " singleQuote: true," +
        " printWidth: 100," +
        " overrides: [{ files: '*.md', options: { printWidth: 80 } }]," +
        " plugins: []" +
        " };\n",
    );
    await fixture.stage("prettier.config.mjs");

    const session = await fixture.open({ source: "index", trust: true });
    const imported = await session.readConfigForImport("prettier.config.mjs");

    expect(imported.settings).toMatchObject({
      singleQuote: true,
      printWidth: 100,
    });
    expect(imported.overrides).toEqual([
      {
        files: "*.md",
        settings: { printWidth: 80 },
      },
    ]);
    expect(imported.limitations).toEqual([]);
  });

  it("retires descendant processes when the worker exits cleanly", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    const pidPath = join(fixture.root, "CHILD_PID");
    await fixture.write(
      "prettier.config.mjs",
      [
        "import { spawn } from 'node:child_process';",
        "import { writeFileSync } from 'node:fs';",
        "const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
        "child.unref();",
        `writeFileSync(${JSON.stringify(pidPath)}, String(child.pid));`,
        "export default {};",
      ].join("\n"),
    );
    await fixture.write("value.ts", "export const value = 1;\n");
    await fixture.stage("prettier.config.mjs", "value.ts");

    const session = await fixture.open({ source: "index", trust: true });
    await session.format("value.ts", "export const value = 1;");
    const descendantPid = Number(await readFile(pidPath, "utf8"));
    onTestFinished(() => {
      try {
        process.kill(descendantPid, "SIGKILL");
      } catch {
        // The session is expected to have retired it already.
      }
    });

    await session.close();

    expect(() => process.kill(descendantPid, 0)).toThrow();
  });

  it("runs a real plugin through the snapshot workspace remap", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      "package.json",
      `${JSON.stringify(
        {
          name: "prettier-fixture",
          private: true,
          workspaces: ["packages/*"],
          devDependencies: {
            prettier: "^3.0.0",
            "fixture-plugin": "*",
          },
        },
        null,
        2,
      )}\n`,
    );
    await fixture.write(
      "packages/fixture-plugin/package.json",
      '{"name":"fixture-plugin","version":"1.0.0","type":"module","main":"index.mjs"}',
    );
    await fixture.write("packages/fixture-plugin/index.mjs", FIXTURE_PLUGIN);
    await fixture.write(".prettierrc.json", '{"plugins":["fixture-plugin"]}');
    await fixture.write("value.fixturetxt", "anything");
    // npm-style workspace link: node_modules/fixture-plugin -> packages/fixture-plugin
    await symlink(
      join(fixture.root, "packages", "fixture-plugin"),
      join(fixture.root, "node_modules", "fixture-plugin"),
      "dir",
    );
    await fixture.stage(
      "package.json",
      ".prettierrc.json",
      "value.fixturetxt",
      "packages/fixture-plugin/package.json",
      "packages/fixture-plugin/index.mjs",
    );

    const session = await fixture.open({ source: "index", trust: true });

    await expect(
      session.format("value.fixturetxt", "anything"),
    ).resolves.toEqual({ kind: "formatted", text: "FIXTURE\n" });
  });

  it("gives a nested-project plugin the mirrored source filepath", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      "web/package.json",
      '{"name":"web","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await fixture.write(
      "web/.prettierrc.json",
      '{"plugins":["./plugin.mjs"]}',
    );
    await fixture.write(
      "web/plugin.mjs",
      [
        'import { existsSync } from "node:fs";',
        'import { dirname, join } from "node:path";',
        'export const languages=[{name:"Fixture",parsers:["fixture"],extensions:[".fixturetxt"]}];',
        'export const parsers={fixture:{parse:()=>({}),astFormat:"fixture",locStart:()=>0,locEnd:()=>0}};',
        'export const printers={fixture:{print:(_path,options)=>existsSync(join(dirname(options.filepath),"sibling.txt"))?"FOUND\\n":"MISSING\\n"}};',
      ].join("\n"),
    );
    await fixture.write("web/sibling.txt", "present\n");
    await fixture.write("web/value.fixturetxt", "anything");
    await fixture.stage(
      "web/package.json",
      "web/.prettierrc.json",
      "web/plugin.mjs",
      "web/sibling.txt",
      "web/value.fixturetxt",
    );

    const session = await fixture.open({
      source: "index",
      trust: true,
      projectRoot: "web",
    });

    await expect(
      session.format("web/value.fixturetxt", "anything"),
    ).resolves.toEqual({ kind: "formatted", text: "FOUND\n" });
  });

  it("follows a pnpm-style installation link outside the repository", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    const store = await mkdtemp(join(tmpdir(), "zedbee-pnpm-store-"));
    onTestFinished(() => rm(store, { recursive: true, force: true }));
    await rm(join(fixture.root, "node_modules", "prettier"), {
      recursive: true,
      force: true,
    });
    await cp(
      join(repositoryPackageRoot, "node_modules", "prettier"),
      join(store, "prettier"),
      { recursive: true },
    );
    await symlink(
      join(store, "prettier"),
      join(fixture.root, "node_modules", "prettier"),
      "dir",
    );
    await fixture.write(".prettierrc.json", '{"singleQuote":true}');
    await fixture.write("value.ts", 'export const value = "hello";\n');
    await fixture.stage(".prettierrc.json", "value.ts");

    const session = await fixture.open({ source: "index", trust: true });

    await expect(
      session.format("value.ts", 'export const value = "hello";'),
    ).resolves.toEqual({
      kind: "formatted",
      text: "export const value = 'hello';\n",
    });
  });

  it("uses a genuinely provisioned Prettier 3.0.3 installation", async () => {
    const fixture = await createProjectPrettierFixture({
      prettierVersion: "3.0.3",
    });
    onTestFinished(() => fixture.dispose());
    await fixture.write(".prettierrc.json", '{"singleQuote":true}');
    await fixture.write("value.ts", 'export const value = "hello";\n');
    await fixture.stage(".prettierrc.json", "value.ts");

    const session = await fixture.open({ source: "index", trust: true });

    await expect(
      session.format("value.ts", 'export const value = "hello";'),
    ).resolves.toEqual({
      kind: "formatted",
      text: "export const value = 'hello';\n",
    });
  });

  it("rejects an installation whose version violates the declared range", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      "package.json",
      `${JSON.stringify({
        name: "prettier-fixture",
        private: true,
        devDependencies: { prettier: "3.0.3" },
      })}\n`,
    );
    await fixture.write("value.ts", "export const value = 1;\n");
    await fixture.stage("package.json", "value.ts");

    const git = new GitClient(fixture.root);
    const snapshot = await buildSnapshotPair(fixture.root, git);
    onTestFinished(() => snapshot.cleanup());
    await requireProjectPrettierTrust(fixture.root, ".", true);

    await expect(
      resolveProjectPrettierInstallation(fixture.root, ".", snapshot.targetDir),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_VERSION_UNSUPPORTED" });
  });

  it("rejects pending work immediately when the worker exits", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      "evil.config.mjs",
      "process.exit(1);\nexport default {};\n",
    );
    await fixture.stage("evil.config.mjs");

    const session = await fixture.open({ source: "index", trust: true });

    await expect(
      session.readConfigForImport("evil.config.mjs"),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_WORKER_FAILED" });
    await expect(
      session.format("value.ts", "export const value = 1;"),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_WORKER_FAILED" });
  });

  it("invalidates the session when a configuration forges an unknown reply id", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      "forged.config.mjs",
      [
        "process.send?.({",
        "  type: 'reply',",
        "  reply: { id: 999, operation: 'classify', result: { kind: 'supported' } },",
        "});",
        "export default {};",
      ].join("\n"),
    );
    await fixture.stage("forged.config.mjs");

    const session = await fixture.open({ source: "index", trust: true });

    await expect(
      session.readConfigForImport("forged.config.mjs"),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_PROTOCOL_INVALID" });
    await expect(
      session.format("value.ts", "export const value = 1;"),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_PROTOCOL_INVALID" });
  });

  it("rejects an already-cancelled session before spawning", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(".prettierrc.json", "{}");
    await fixture.write("value.ts", "export const value = 1;\n");
    await fixture.stage(".prettierrc.json", "value.ts", "package.json");
    const git = new GitClient(fixture.root);
    const snapshot = await buildSnapshotPair(fixture.root, git);
    onTestFinished(() => snapshot.cleanup());
    const permit = await requireProjectPrettierTrust(fixture.root, ".", true);
    const installation = await resolveProjectPrettierInstallation(
      fixture.root,
      ".",
      snapshot.targetDir,
    );
    const controller = new AbortController();
    controller.abort();

    await expect(
      openProjectFormatter({
        checkoutRoot: await realpath(fixture.root),
        snapshotRoot: snapshot.targetDir,
        projectRoot: ".",
        installation,
        permit,
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_WORKER_FAILED" });
  });

  it("applies path-scoped and tab EditorConfig sections", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      ".editorconfig",
      [
        "root = true",
        "",
        "[*]",
        "indent_size = 4",
        "",
        "[*.{js,ts}]",
        "indent_size = tab",
        "tab_width = 6",
        "",
        "[*.md]",
        "max_line_length = 40",
        "",
        "[nested/*.ts]",
        "indent_style = space",
        "indent_size = 2",
      ].join("\n"),
    );
    await fixture.write("value.ts", "export const value = 1;\n");
    await fixture.write("nested/value.ts", "export const value = 1;\n");
    await fixture.write("docs.md", "# a\n");
    await fixture.stage(
      ".editorconfig",
      "value.ts",
      "nested/value.ts",
      "docs.md",
    );

    const session = await fixture.open({ source: "index", trust: true });

    // indent_size=tab supplies a width; indent_style alone chooses tabs.
    const tsResult = await session.format(
      "value.ts",
      "function indented(){if(true){return 1}}\n",
    );
    expect(tsResult.kind).toBe("formatted");
    if (tsResult.kind === "formatted") {
      const options = await nativePrettier.resolveConfig(
        join(fixture.root, "value.ts"),
        { editorconfig: true },
      );
      expect(tsResult.text).toBe(
        await nativePrettier.format(
          "function indented(){if(true){return 1}}\n",
          { ...options, filepath: "value.ts" },
        ),
      );
      expect(tsResult.text).toContain("      if");
    }
    // [nested/*.ts] is path-scoped and wins over the shallower sections.
    const nested = await session.format(
      "nested/value.ts",
      "function indented(){if(true){return 2}}\n",
    );
    expect(nested.kind).toBe("formatted");
    if (nested.kind === "formatted") {
      expect(nested.text).not.toContain("\t");
      expect(nested.text).toContain("  ");
    }
    // [*.md] applies by file name at any depth with its own width.
    const md = await session.format("docs.md", "# a\n");
    expect(md.kind).toBe("formatted");
  });

  it("reports every dropped value from a consented executable configuration", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      "prettier.config.mjs",
      [
        "const config = { printWidth: 90, semi: false };",
        "config.self = config;",
        "config.plugins = ['a-plugin'];",
        "config.parser = 'babel';",
        "config.mystery = () => 2;",
        "Object.defineProperty(config, 'guarded', { get() { return 1; }, enumerable: true });",
        "export default config;",
      ].join("\n"),
    );
    await fixture.stage("prettier.config.mjs");

    const session = await fixture.open({ source: "index", trust: true });
    const imported = await session.readConfigForImport("prettier.config.mjs");

    expect(imported.settings).toEqual({ printWidth: 90, semi: false });
    const joined = imported.limitations.join("\n");
    expect(joined).toMatch(/plugins/u);
    expect(joined).toMatch(/"parser"/u);
    expect(joined).toMatch(/"mystery"/u);
    expect(joined).toMatch(/accessor|non-data/u);
    expect(joined).toMatch(/"guarded"/u);
    expect(joined).toMatch(/"self"/u);
  });

  it("rejects the ready handshake promptly on abort after spawn", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      "package.json",
      `{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}\n`,
    );
    await fixture.write(
      "slow-entry.mjs",
      "await new Promise((resolve) => setTimeout(resolve, 4_000));\n" +
        "export async function format(source) { return source; }\n" +
        "export async function resolveConfigFile() { return null; }\n" +
        "export async function resolveConfig() { return {}; }\n" +
        "export async function getFileInfo() { return { ignored: false, inferredParser: 'babel' }; }\n",
    );
    await fixture.stage("package.json", "slow-entry.mjs");
    const git = new GitClient(fixture.root);
    const snapshot = await buildSnapshotPair(fixture.root, git);
    onTestFinished(() => snapshot.cleanup());
    const permit = await requireProjectPrettierTrust(fixture.root, ".", true);
    const installation = await resolveProjectPrettierInstallation(
      fixture.root,
      ".",
      snapshot.targetDir,
    );
    const slowInstallation = {
      ...installation,
      entryUrl: pathToFileURL(join(fixture.root, "slow-entry.mjs")).href,
    };
    const controller = new AbortController();
    const startedAt = Date.now();

    const opening = openProjectFormatter({
      checkoutRoot: await realpath(fixture.root),
      snapshotRoot: snapshot.targetDir,
      projectRoot: ".",
      installation: slowInstallation,
      permit,
      signal: controller.signal,
    });
    // Abort while startup is still waiting for the slow worker's ready.
    await new Promise((resolve) => setTimeout(resolve, 150));
    controller.abort();

    await expect(opening).rejects.toMatchObject({
      code: "PROJECT_PRETTIER_WORKER_FAILED",
    });
    const elapsed = Date.now() - startedAt;
    // The rejection must be prompt: the worker deliberately sleeps past
    // this bound, and the startup timer alone is 10 seconds.
    expect(elapsed).toBeLessThan(2_000);
  });

  it("applies snapshot EditorConfig values when no Prettier config exists", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      ".editorconfig",
      "root = true\n\n[*]\nmax_line_length = 100\nindent_size = 4\n",
    );
    const args = Array.from({ length: 18 }, (_, index) => index + 1).join(", ");
    await fixture.write("value.ts", `export const value = value(${args});\n`);
    await fixture.stage(".editorconfig", "value.ts");

    const session = await fixture.open({ source: "index", trust: true });

    const result = await session.format(
      "value.ts",
      `export const value = value(${args});`,
    );
    expect(result.kind).toBe("formatted");
    if (result.kind !== "formatted") return;
    // Under the managed default print width of 80 this call would wrap; the
    // project's EditorConfig width of 100 keeps it on one line.
    expect(result.text.trim().split("\n")).toHaveLength(1);
  });
});

it("keeps native indentation semantics without a Prettier config", async () => {
  const fixture = await createProjectPrettierFixture();
  onTestFinished(() => fixture.dispose());
  await fixture.write(
    ".editorconfig",
    "root = true\n[*]\nindent_style = space\nindent_size = 2\ntab_width = 8\n",
  );
  await fixture.write("value.ts", "function x(){return 1;}");
  await fixture.stage(".editorconfig", "value.ts");
  const session = await fixture.open({ source: "index", trust: true });
  expect(await session.format("value.ts", "function x(){return 1;}")).toEqual({
    kind: "formatted",
    text: "function x() {\n  return 1;\n}\n",
  });
});

it("batches files in one worker and retires it before the next session", async () => {
  const fixture = await createProjectPrettierFixture();
  onTestFinished(() => fixture.dispose());
  await fixture.write(
    "prettier.config.mjs",
    "export default {semi: process.pid % 2 === 0};",
  );
  await fixture.write(
    "node_modules/pid-plugin/package.json",
    '{"name":"pid-plugin","type":"module","exports":"./index.js"}',
  );
  await fixture.write(
    "node_modules/pid-plugin/index.js",
    `export const languages=[{name:"pid",parsers:["pid"],extensions:[".pid"]}];export const parsers={pid:{parse:()=>({}),astFormat:"pid",locStart:()=>0,locEnd:()=>0}};export const printers={pid:{print:()=>String(process.pid)}};`,
  );
  await fixture.write(
    "package.json",
    '{"name":"fixture","devDependencies":{"prettier":"^3.0.0","pid-plugin":"*"}}',
  );
  await fixture.write(
    "prettier.config.mjs",
    'export default {plugins:["pid-plugin"]};',
  );
  await fixture.write("a.pid", "a");
  await fixture.write("b.pid", "b");
  await fixture.stage("package.json", "prettier.config.mjs", "a.pid", "b.pid");
  const first = await fixture.open({ source: "index", trust: true });
  const a = await first.format("a.pid", "a");
  expect(await first.format("b.pid", "b")).toEqual(a);
  await first.close();
  if (a.kind !== "formatted") throw new Error("Expected formatted PID");
  expect(() => process.kill(Number(a.text), 0)).toThrow();
  const second = await fixture.open({ source: "index", trust: true });
  expect(await second.format("a.pid", "a")).not.toEqual(a);
});
