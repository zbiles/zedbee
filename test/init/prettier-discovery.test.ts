import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { GitClient } from "../../src/git/client.js";
import { discoverProjectPrettier } from "../../src/init/prettier-discovery.js";
import { createInspectionFixture } from "../inspection/fixture.js";

async function markerExists(root: string, name: string): Promise<boolean> {
  try {
    await lstat(join(root, name));
    return true;
  } catch {
    return false;
  }
}

describe("discoverProjectPrettier", () => {
  it("ignores checkout copies while finding an untracked web project without a root manifest", async () => {
    const fixture = await createInspectionFixture();
    await new GitClient(fixture.root).run(["init"]);
    await fixture.write(".gitignore", ".claude/worktrees/\n");
    await fixture.writeJson("web/package.json", {
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.writeJson(".claude/worktrees/old/web/package.json", {
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.write(".claude/worktrees/old/.prettierrc.json", "{}");

    expect(
      (await discoverProjectPrettier(fixture.root)).map(
        (entry) => entry.projectRoot,
      ),
    ).toEqual(["web"]);
  });

  it("does not attach ignored config-only directories to a root project", async () => {
    const fixture = await createInspectionFixture();
    await new GitClient(fixture.root).run(["init"]);
    await fixture.write(".gitignore", ".claude/worktrees/\n");
    await fixture.writeJson("package.json", {
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.write(".prettierrc.json", "{}");
    await fixture.write(
      ".claude/worktrees/old/prettier.config.mjs",
      "export default {};",
    );

    expect(
      (await discoverProjectPrettier(fixture.root))[0]?.configPaths,
    ).toEqual([".prettierrc.json"]);
  });

  it.each(["directory", "file"])(
    "excludes nested repositories with a .git %s",
    async (kind) => {
      const fixture = await createInspectionFixture();
      const git = new GitClient(fixture.root);
      await git.run(["init"]);
      await fixture.writeJson("web/package.json", {
        devDependencies: { prettier: "^3.0.0" },
      });
      await fixture.writeJson("copies/old/package.json", {
        devDependencies: { prettier: "^3.0.0" },
      });
      // Track the files first: repository boundaries apply even to tracked paths.
      await git.run(["add", "."]);
      if (kind === "directory")
        await new GitClient(join(fixture.root, "copies/old")).run(["init"]);
      else
        await fixture.write(
          "copies/old/.git",
          "gitdir: /outside/old-worktree\n",
        );

      expect(
        (await discoverProjectPrettier(fixture.root)).map(
          (entry) => entry.projectRoot,
        ),
      ).toEqual(["web"]);
    },
  );

  it("finds a declared and installed project Prettier", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.writeJson("node_modules/prettier/package.json", {
      name: "prettier",
      version: "3.9.6",
    });
    await fixture.write(".prettierrc.json", "{}");

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      projectRoot: ".",
      version: "3.9.6",
      status: "available",
      executableConfig: false,
    });
    expect(discovered[0]?.configPaths).toEqual([".prettierrc.json"]);
    expect(discovered[0]?.packageRoot).toContain(
      join("node_modules", "prettier"),
    );
  });

  it("resolves a nested project through a hoisted installation", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "root",
      private: true,
      workspaces: ["packages/*"],
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.writeJson("packages/app/package.json", {
      name: "app",
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.writeJson("node_modules/prettier/package.json", {
      name: "prettier",
      version: "3.3.0",
    });

    const discovered = await discoverProjectPrettier(fixture.root);

    const nested = discovered.find(
      (entry) => entry.projectRoot === "packages/app",
    );
    expect(nested).toMatchObject({ version: "3.3.0", status: "available" });
  });

  it("does not offer a hoisted installation the project never declared or configured", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { typescript: "^5.0.0" },
    });
    // npm can hoist Zedbee's own transitive Prettier here; it is not a choice.
    await fixture.writeJson("node_modules/prettier/package.json", {
      name: "prettier",
      version: "3.9.6",
    });

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered).toEqual([]);
  });

  it("does not report config-only setup as runnable through an undeclared hoisted copy", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { typescript: "^5.0.0" },
    });
    await fixture.write(".prettierrc.json", "{}");
    // This may be Zedbee's own hoisted dependency. Project mode must not use it
    // unless the selected project or one of its ancestors declares Prettier.
    await fixture.writeJson("node_modules/prettier/package.json", {
      name: "prettier",
      version: "3.9.6",
    });

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      projectRoot: ".",
      status: "missing",
      configPaths: [".prettierrc.json"],
    });
    expect(discovered[0]?.version).toBeUndefined();
    expect(discovered[0]?.packageRoot).toBeUndefined();
  });

  it("accepts a nested config backed by an ancestor Prettier declaration", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "root",
      private: true,
      workspaces: ["packages/*"],
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.writeJson("packages/app/package.json", { name: "app" });
    await fixture.write("packages/app/.prettierrc.json", "{}");
    await fixture.writeJson("node_modules/prettier/package.json", {
      name: "prettier",
      version: "3.9.6",
    });

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(
      discovered.find((entry) => entry.projectRoot === "packages/app"),
    ).toMatchObject({
      declaredRange: "^3.0.0",
      version: "3.9.6",
      status: "available",
    });
  });

  it("rejects an installed version that violates the project's declared range", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: "~3.3.0" },
    });
    await fixture.writeJson("node_modules/prettier/package.json", {
      name: "prettier",
      version: "3.9.6",
    });

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered[0]).toMatchObject({
      version: "3.9.6",
      declaredRange: "~3.3.0",
      status: "unsupported",
    });
  });

  it("recognizes TypeScript executable configuration forms", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.write(".prettierrc.cts", "export default {}\n");
    await fixture.writeJson("packages/app/package.json", { name: "app" });
    await fixture.write(
      "packages/app/prettier.config.mts",
      "export default {}\n",
    );

    const discovered = await discoverProjectPrettier(fixture.root);

    const root = discovered.find((entry) => entry.projectRoot === ".");
    expect(root?.configPaths).toEqual([".prettierrc.cts"]);
    expect(root?.executableConfig).toBe(true);
    const nested = discovered.find(
      (entry) => entry.projectRoot === "packages/app",
    );
    expect(nested?.configPaths).toEqual(["packages/app/prettier.config.mts"]);
    expect(nested?.executableConfig).toBe(true);
  });

  it("reports a declared but uninstalled Prettier as missing", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      devDependencies: { prettier: "^3.0.0" },
    });

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      projectRoot: ".",
      status: "missing",
    });
    expect(discovered[0]?.version).toBeUndefined();
  });

  it("reports an out-of-range installed Prettier as unsupported", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      devDependencies: { prettier: "4.0.0" },
    });
    await fixture.writeJson("node_modules/prettier/package.json", {
      name: "prettier",
      version: "4.0.0",
    });

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered[0]).toMatchObject({
      version: "4.0.0",
      status: "unsupported",
    });
  });

  it("does not follow an installation symlink outside the repository", async () => {
    const fixture = await createInspectionFixture();
    const outside = await mkdtemp(join(tmpdir(), "zedbee-prettier-outside-"));
    onTestFinished(() => rm(outside, { recursive: true, force: true }));
    await fixture.writeJson("package.json", {
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.symlink(outside, "node_modules/prettier");

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered[0]).toMatchObject({ status: "missing" });
    expect(discovered[0]?.packageRoot).toBeUndefined();
  });

  it("accepts a declared pnpm-style installation link outside the repository", async () => {
    const fixture = await createInspectionFixture();
    const outside = await mkdtemp(join(tmpdir(), "zedbee-prettier-store-"));
    onTestFinished(() => rm(outside, { recursive: true, force: true }));
    await fixture.writeJson("package.json", {
      devDependencies: { prettier: "^3.0.0" },
    });
    await writeFile(
      join(outside, "package.json"),
      '{"name":"prettier","version":"3.9.6"}',
    );
    await fixture.symlink(outside, "node_modules/prettier");

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered[0]).toMatchObject({
      status: "available",
      version: "3.9.6",
    });
  });

  it("finds an executable config without executing it", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.write(
      "prettier.config.mjs",
      "import { writeFileSync } from 'node:fs';\n" +
        "writeFileSync(new URL('./MARKER_EXECUTED', import.meta.url), 'executed');\n" +
        "export default { singleQuote: true };\n",
    );

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered[0]?.configPaths).toEqual(["prettier.config.mjs"]);
    expect(discovered[0]?.executableConfig).toBe(true);
    expect(await markerExists(fixture.root, "MARKER_EXECUTED")).toBe(false);
  });

  it("discovers configuration directories below a package root", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "app",
      devDependencies: { prettier: "^3.0.0" },
    });
    await fixture.write(".prettierrc.json", "{}");
    await fixture.write("src/.prettierrc.json", '{"semi":false}');

    const discovered = await discoverProjectPrettier(fixture.root);

    expect(discovered[0]?.configPaths).toEqual([
      ".prettierrc.json",
      "src/.prettierrc.json",
    ]);
  });
});
