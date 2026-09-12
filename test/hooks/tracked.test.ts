import { chmod, lstat, readFile, symlink, unlink } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { detectHookIntegration } from "../../src/hooks/detect.js";
import { installTrackedHooks } from "../../src/hooks/install.js";
import { createInitProposal } from "../../src/init/recommend.js";
import { applyInitProposal } from "../../src/init/write-config.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("tracked hook installation", () => {
  it("does not let clone activation disable a teammate's custom local hooks", async () => {
    const repo = await createGitRepository("zedbee-tracked-clone-local-");
    await repo.write(".husky/pre-commit", "#!/bin/sh\nexit 0\n");
    await repo.write(".git/hooks/commit-msg", "#!/bin/sh\nexit 19\n");
    await chmod(join(repo.root, ".git/hooks/commit-msg"), 0o755);
    await expect(installTrackedHooks(repo.root)).rejects.toThrow();
    expect(
      (await repo.git(["hook", "run", "commit-msg", "--", "message"])).exitCode,
    ).toBe(19);
  });
  it("refuses a symlinked Git config without writing the proposed files", async () => {
    const repo = await createGitRepository("zedbee-tracked-config-");
    const outside = await createGitRepository("zedbee-tracked-config-outside-");
    await repo.write("package.json", '{"name":"fixture"}');
    const integration = await detectHookIntegration(repo.root, "tracked");
    const proposal = createInitProposal(await inspectRepository(repo.root), {
      repositoryRoot: repo.root,
      profile: "recommended",
      hook: integration.hook,
      hookChanges: integration.changes,
      hooksPathChange: integration.hooksPathChange,
    });
    const before = await outside.read(".git/config");
    await unlink(join(repo.root, ".git/config"));
    await symlink(
      join(outside.root, ".git/config"),
      join(repo.root, ".git/config"),
    );
    await expect(applyInitProposal(proposal)).rejects.toThrow();
    expect(await outside.read(".git/config")).toBe(before);
    await expect(repo.read(".husky/pre-commit")).rejects.toThrow();
  });
  it.each([
    "#!/usr/bin/env node\nprocess.exit(0);\n",
    "#!/bin/bash\n[[ -f package.json ]]\n",
  ])(
    "refuses to migrate a hook whose interpreter would change",
    async (script) => {
      const repo = await createGitRepository("zedbee-tracked-interpreter-");
      await repo.write("package.json", '{"name":"fixture"}');
      await repo.write(".git/hooks/commit-msg", script);
      await chmod(join(repo.root, ".git/hooks/commit-msg"), 0o755);
      await expect(
        detectHookIntegration(repo.root, "tracked"),
      ).rejects.toThrow();
      expect(await repo.read(".git/hooks/commit-msg")).toBe(script);
    },
  );

  it("refuses to disable an unsupported existing Git hook", async () => {
    const repo = await createGitRepository("zedbee-tracked-other-hook-");
    await repo.write("package.json", '{"name":"fixture"}');
    await repo.write(".git/hooks/reference-transaction", "#!/bin/sh\nexit 0\n");
    await chmod(join(repo.root, ".git/hooks/reference-transaction"), 0o755);
    await expect(detectHookIntegration(repo.root, "tracked")).rejects.toThrow();
  });
  it("activates Git and preserves prepare without running project scripts or disabled hooks", async () => {
    const repo = await createGitRepository("zedbee-tracked-");
    await repo.write(
      "package.json",
      JSON.stringify({
        name: "fixture",
        scripts: {
          prepare: "node -e \"throw Error('must not run')\"",
          test: "original",
        },
      }),
    );
    await repo.write(".git/hooks/pre-commit", "#!/bin/sh\nexit 19\n");
    await chmod(join(repo.root, ".git/hooks/pre-commit"), 0o644);
    const integration = await detectHookIntegration(repo.root, "tracked");
    const proposal = createInitProposal(await inspectRepository(repo.root), {
      repositoryRoot: repo.root,
      profile: "recommended",
      hook: integration.hook,
      hookChanges: integration.changes,
      hookActivation: integration.activation,
      hooksPathChange: integration.hooksPathChange,
    });
    await applyInitProposal(proposal);
    const manifest = JSON.parse(await repo.read("package.json"));
    expect(manifest.scripts.prepare).toBe(
      "node -e \"throw Error('must not run')\" && node .husky/install.mjs",
    );
    expect(manifest.scripts.test).toBe("original");
    expect((await repo.git(["config", "core.hooksPath"])).stdout).toBe(
      ".husky/_",
    );
    await repo.write("node_modules/.bin/zedbee", "#!/bin/sh\nexit 23\n");
    await chmod(join(repo.root, "node_modules/.bin/zedbee"), 0o755);
    expect((await repo.git(["hook", "run", "pre-commit"])).exitCode).toBe(23);
    expect(
      (await detectHookIntegration(repo.root, "auto")).activation.status,
    ).toBe("active");
  });

  it("does not break a production install when the dev dependency is absent", async () => {
    const repo = await createGitRepository("zedbee-tracked-production-");
    await repo.write("package.json", '{"name":"fixture"}');
    const integration = await detectHookIntegration(repo.root, "tracked");
    const installer = integration.changes!.find(
      (change) => change.relativePath === ".husky/install.mjs",
    )!;
    await repo.write(installer.relativePath, installer.after);
    const result = await execa(process.execPath, [".husky/install.mjs"], {
      cwd: repo.root,
      reject: false,
    });
    expect(result.exitCode).toBe(0);
    expect(
      (await repo.git(["config", "--get", "core.hooksPath"])).exitCode,
    ).toBe(1);
  });

  it("reinstalls the dispatcher for a clone without executing its existing hooks", async () => {
    const repo = await createGitRepository("zedbee-tracked-clone-");
    await repo.write(".husky/pre-commit", "#!/bin/sh\nexit 17\n");
    await installTrackedHooks(repo.root);
    await chmod(join(repo.root, ".husky/_/pre-commit"), 0o644);
    await installTrackedHooks(repo.root);
    expect(
      (await lstat(join(repo.root, ".husky/_/pre-commit"))).mode & 0o111,
    ).not.toBe(0);
    expect((await repo.git(["hook", "run", "pre-commit"])).exitCode).toBe(17);
    expect(await readFile(join(repo.root, ".husky/pre-commit"), "utf8")).toBe(
      "#!/bin/sh\nexit 17\n",
    );
  });

  it("refuses a symbolic-link dispatcher directory before reading or changing targets", async () => {
    const repo = await createGitRepository("zedbee-tracked-symlink-");
    const outside = await createGitRepository("zedbee-tracked-outside-");
    await repo.write("package.json", '{"name":"fixture"}');
    await repo.write(".husky/placeholder", "");
    await outside.write("h", "private runtime");
    await symlink(outside.root, join(repo.root, ".husky/_"));
    await expect(detectHookIntegration(repo.root, "tracked")).rejects.toThrow();
    expect(await outside.read("h")).toBe("private runtime");
  });
});
