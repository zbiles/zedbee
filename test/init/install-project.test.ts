import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { createGitRepository } from "../helpers/git-repository.js";
import { projectInstallTargets } from "../../src/init/install-project.js";
import { ZEDBEE_VERSION } from "../../src/core/package-version.js";

describe("project installation targets", () => {
  it("offers eligible folders and identifies their formatter and package manager", async () => {
    const repo = await createGitRepository();
    await repo.write("e2e/package.json", '{"name":"tests"}');
    await repo.write(
      "web/package.json",
      '{"name":"web","packageManager":"pnpm@10.0.0"}',
    );
    await repo.write("web/.prettierrc.json", "{}");
    const targets = await projectInstallTargets(repo.root, ["e2e", "web"]);
    expect(targets).toEqual([
      expect.objectContaining({
        projectRoot: "e2e",
        manager: "npm",
        hasPrettier: false,
      }),
      expect.objectContaining({
        projectRoot: "web",
        manager: "pnpm",
        hasPrettier: true,
      }),
    ]);
    expect(targets[1]?.args).toContain(`zedbee@${ZEDBEE_VERSION}`);
  });
  it("inherits a workspace manager from the repository root", async () => {
    const repo = await createGitRepository();
    await repo.write(
      "package.json",
      '{"private":true,"packageManager":"yarn@4.0.0","workspaces":["web"]}',
    );
    await repo.write("web/package.json", '{"name":"web"}');
    const [target] = await projectInstallTargets(repo.root, ["web"]);
    expect(target?.manager).toBe("yarn");
    expect(target?.projectRoot).toBe("web");
  });

  it.each([
    ["npm@11.0.0", ["--ignore-scripts"]],
    ["pnpm@10.0.0", ["--ignore-scripts", "--ignore-pnpmfile"]],
    ["yarn@1.22.22", ["--ignore-scripts", "--no-default-rc"]],
    ["yarn@4.0.0", ["--mode=skip-build"]],
    ["bun@1.4.0", ["--ignore-scripts"]],
  ])("suppresses install-time code for %s", async (packageManager, flags) => {
    const repo = await createGitRepository();
    await repo.write(
      "package.json",
      JSON.stringify({ name: "fixture", packageManager }),
    );
    const [target] = await projectInstallTargets(repo.root, ["."]);
    expect(target?.args).toEqual(expect.arrayContaining(flags));
  });

  it("installs with real npm without running root or dependency lifecycle scripts", async () => {
    const repo = await createGitRepository();
    const fixture = await createGitRepository();
    const lifecycle = (marker: string) =>
      `node -e ${JSON.stringify(`require('node:fs').writeFileSync(${JSON.stringify(join(repo.root, marker))}, 'executed')`)}`;
    const scripts = Object.fromEntries(
      ["preinstall", "install", "postinstall", "prepare"].map((event) => [
        event,
        lifecycle(`dependency-${event}`),
      ]),
    );
    await fixture.write(
      "package.json",
      JSON.stringify({
        name: "zedbee",
        version: ZEDBEE_VERSION,
        bin: { zedbee: "cli.js" },
        scripts,
      }),
    );
    await fixture.write("cli.js", "// Synthetic package: never executed.\n");
    const packed = await execa(
      "npm",
      [
        "pack",
        "--ignore-scripts",
        "--json",
        "--update-notifier=false",
        "--cache",
        join(fixture.root, ".npm-cache"),
      ],
      { cwd: fixture.root },
    );
    const metadata = JSON.parse(packed.stdout) as { filename: string }[];
    const tarball = join(fixture.root, metadata[0]!.filename);
    await repo.write(
      "package.json",
      JSON.stringify({
        name: "root-fixture",
        private: true,
        scripts: Object.fromEntries(
          Object.keys(scripts).map((event) => [
            event,
            lifecycle(`root-${event}`),
          ]),
        ),
      }),
    );
    await repo.write(
      ".npmrc",
      `offline=true\naudit=false\nfund=false\nupdate-notifier=false\ncache=${join(repo.root, ".npm-cache")}\nignore-scripts=false\n`,
    );
    const [target] = await projectInstallTargets(repo.root, ["."]);
    await execa(
      target!.manager,
      target!.args.map((arg) => (arg.startsWith("zedbee@") ? tarball : arg)),
      { cwd: repo.root },
    );
    expect(
      (await readdir(repo.root)).filter((name) =>
        /^(root|dependency)-/u.test(name),
      ),
    ).toEqual([]);
    expect(
      JSON.parse(await repo.read("node_modules/zedbee/package.json")).version,
    ).toBe(ZEDBEE_VERSION);
  });
});
