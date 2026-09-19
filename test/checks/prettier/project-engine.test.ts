import { cp, lstat, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { describe, expect, it, onTestFinished } from "vitest";
import { mkdtemp } from "node:fs/promises";
import {
  openProjectFormatter,
  resolveProjectPrettierInstallation,
} from "../../../src/checks/prettier/project-engine.js";
import { requireProjectPrettierTrust } from "../../../src/checks/prettier/project-trust.js";
import { createProjectPrettierFixture } from "../../helpers/project-prettier.js";
import { buildSnapshotPair } from "../../../src/git/snapshot.js";
import { GitClient } from "../../../src/git/client.js";
import { realpath } from "node:fs/promises";

const repositoryPackageRoot = fileURLToPath(new URL("../../..", import.meta.url));

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
    await fixture.write(
      "packages/fixture-plugin/index.mjs",
      FIXTURE_PLUGIN,
    );
    await fixture.write(
      ".prettierrc.json",
      '{"plugins":["fixture-plugin"]}',
    );
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
