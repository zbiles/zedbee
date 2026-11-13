import { parse as parseYaml } from "yaml";
import { updateHuskyHook } from "../../src/hooks/husky.js";
import { updateLefthookConfig } from "../../src/hooks/lefthook.js";
import { updateSimpleGitHooksManifest } from "../../src/hooks/simple-git-hooks.js";
import { chmod, realpath, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { createGitRepository } from "../helpers/git-repository.js";
import {
  resolveHookCommand,
  resolveLocalSchemaReference,
} from "../../src/hooks/command.js";
import { detectHookIntegration } from "../../src/hooks/detect.js";
import { updateRawGitHook } from "../../src/hooks/raw-git.js";

async function installed(
  repository: Awaited<ReturnType<typeof createGitRepository>>,
  root: string,
) {
  const prefix = root === "." ? "" : `${root}/`;
  await repository.write(
    `${prefix}package.json`,
    JSON.stringify({ name: "app", devDependencies: { zedbee: "*" } }),
  );
  await repository.write(
    `${prefix}node_modules/zedbee/package.json`,
    JSON.stringify({ name: "zedbee", bin: { zedbee: "dist/cli.cjs" } }),
  );
  await repository.write(
    `${prefix}node_modules/zedbee/dist/cli.cjs`,
    `require('node:fs').writeFileSync('hook-result.json', JSON.stringify({cwd: process.cwd(), args: process.argv.slice(2)}));`,
  );
}

describe("installed hook command", () => {
  it.each(["web", "web app's"])(
    "runs the installed %s CLI from the repository root without a root manifest",
    async (root) => {
      const repository = await createGitRepository();
      await installed(repository, root);
      const command = await resolveHookCommand(repository.root);
      const hook = updateRawGitHook(null, command);
      expect(updateRawGitHook(hook, command)).toBe(hook);
      await repository.write(".git/hooks/pre-commit", hook);
      await chmod(join(repository.root, ".git/hooks/pre-commit"), 0o755);
      const result = await repository.git(["hook", "run", "pre-commit"]);
      expect(result.exitCode, result.stderr).toBe(0);
      const invocation = JSON.parse(await repository.read("hook-result.json"));
      expect(invocation.cwd).toBe(await realpath(repository.root));
      expect(invocation.args).toEqual(["scan", "--hook-invocation"]);
      await expect(repository.read("package.json")).rejects.toMatchObject({
        code: "ENOENT",
      });
    },
  );

  it("explains where to install instead of accepting a missing dependency", async () => {
    const repository = await createGitRepository();
    await repository.write("web/package.json", '{"name":"app"}');
    await expect(resolveHookCommand(repository.root)).rejects.toThrow(/web/);
  });

  it("rejects a declared but absent installation", async () => {
    const repository = await createGitRepository();
    await repository.write(
      "web/package.json",
      '{"devDependencies":{"zedbee":"*"}}',
    );
    await expect(resolveHookCommand(repository.root)).rejects.toThrow(
      /install/i,
    );
  });

  it("lists every project folder when no project declares Zedbee", async () => {
    const repository = await createGitRepository();
    await repository.write("e2e/package.json", '{"name":"tests"}');
    await repository.write("web/package.json", '{"name":"app"}');
    await expect(resolveHookCommand(repository.root)).rejects.toThrow(
      /one of these project folders: e2e, web/,
    );
  });

  it("does not select an installation in an ignored project", async () => {
    const repository = await createGitRepository();
    await repository.write(".gitignore", ".claude/\n");
    await installed(repository, ".claude/worktrees/old");
    await expect(resolveHookCommand(repository.root)).rejects.toThrow(
      /install/i,
    );
  });

  it("uses a hoisted installation declared by a nested package", async () => {
    const repository = await createGitRepository();
    await installed(repository, ".");
    await repository.write(
      "package.json",
      '{"private":true,"workspaces":["web"]}',
    );
    await repository.write(
      "web/package.json",
      '{"devDependencies":{"zedbee":"*"}}',
    );
    expect(await resolveHookCommand(repository.root)).toContain(
      "./node_modules/zedbee/dist/cli.cjs",
    );
    await repository.write(
      "node_modules/zedbee/schema/zedbee.schema.json",
      "{}",
    );
    expect(await resolveLocalSchemaReference(repository.root)).toBe(
      "./node_modules/zedbee/schema/zedbee.schema.json",
    );
  });

  it("passes the resolved command through hook detection without duplicating existing checks", async () => {
    const repository = await createGitRepository();
    await installed(repository, "web");
    await repository.write(
      ".git/hooks/pre-commit",
      "#!/bin/sh\nprintf existing\n",
    );
    const command = await resolveHookCommand(repository.root);
    const integration = await detectHookIntegration(
      repository.root,
      "raw",
      command,
    );
    expect(integration.change?.after).toContain(command);
    expect(integration.change?.after).toContain("printf existing");
  });
});

it.each(["husky", "lefthook", "simple-git-hooks"] as const)(
  "refreshes a generated %s command to the installed location and runs it once",
  async (manager) => {
    const repository = await createGitRepository();
    await installed(repository, "web");
    const command = await resolveHookCommand(repository.root);
    const previous = "npx --no-install zedbee scan --hook-invocation";
    let hook: string;
    if (manager === "husky") {
      hook = updateHuskyHook(`#!/bin/sh\n${previous}\n`, command);
      expect(updateHuskyHook(hook, command)).toBe(hook);
    } else if (manager === "lefthook") {
      const config = updateLefthookConfig(
        `pre-commit:\n  commands:\n    zedbee:\n      run: ${previous}\n`,
        command,
      );
      expect(updateLefthookConfig(config, command)).toBe(config);
      hook = `#!/bin/sh\n${parseYaml(config)["pre-commit"].commands.zedbee.run}\n`;
    } else {
      const config = updateSimpleGitHooksManifest(
        JSON.stringify({ "simple-git-hooks": { "pre-commit": previous } }),
        command,
      );
      expect(updateSimpleGitHooksManifest(config, command)).toBe(config);
      hook = `#!/bin/sh\n${JSON.parse(config)["simple-git-hooks"]["pre-commit"]}\n`;
    }
    hook = hook.replace("#!/bin/sh\n", "#!/bin/sh\nset -e\ncd web\n");
    hook += `node -e "require('node:fs').writeFileSync('after-cwd.txt', process.cwd())"\n`;
    await repository.write(".git/hooks/pre-commit", hook);
    await chmod(join(repository.root, ".git/hooks/pre-commit"), 0o755);
    const result = await repository.git(["hook", "run", "pre-commit"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(await repository.read("web/after-cwd.txt")).toBe(
      await realpath(join(repository.root, "web")),
    );
    expect(JSON.parse(await repository.read("hook-result.json")).args).toEqual([
      "scan",
      "--hook-invocation",
    ]);
  },
);

it("requires simple-git-hooks activation after refreshing its installed command", async () => {
  const repository = await createGitRepository();
  await installed(repository, "web");
  await repository.write(
    "package.json",
    JSON.stringify({
      "simple-git-hooks": {
        "pre-commit": "npx --no-install zedbee scan --hook-invocation",
      },
    }),
  );
  await repository.write(
    ".git/hooks/pre-commit",
    "#!/bin/sh\nnpx --no-install zedbee scan --hook-invocation\n",
  );
  await chmod(join(repository.root, ".git/hooks/pre-commit"), 0o755);
  const command = await resolveHookCommand(repository.root);
  const before = await detectHookIntegration(
    repository.root,
    "simple-git-hooks",
    command,
  );
  expect(before.activation.status).toBe("pending");
  expect(before.activation.remediation).toContain("simple-git-hooks");
  await repository.write(".git/hooks/pre-commit", `#!/bin/sh\n${command}\n`);
  const mergeCommand = await resolveHookCommand(
    repository.root,
    "pre-merge-commit",
  );
  await repository.write(
    ".git/hooks/pre-merge-commit",
    `#!/bin/sh\n${mergeCommand}\n`,
  );
  await chmod(join(repository.root, ".git/hooks/pre-merge-commit"), 0o755);
  const after = await detectHookIntegration(
    repository.root,
    "simple-git-hooks",
    command,
  );
  expect(after.activation.status).toBe("active");
});

// Removing the runtime guard must fail these actual shell/commit regressions.
it.each([".", "web", "web app's $literal `name`"])(
  "explains a missing installed CLI in %s and stops a real commit",
  async (root) => {
    const repo = await createGitRepository();
    await repo.write(".gitignore", "node_modules/\n");
    await installed(repo, root);
    await repo.commitAll("baseline");
    const command = await resolveHookCommand(repo.root);
    await repo.write(
      ".git/hooks/pre-commit",
      updateRawGitHook(null, command) + "touch should-not-run\n",
    );
    await chmod(join(repo.root, ".git/hooks/pre-commit"), 0o755);
    const cli = join(repo.root, root, "node_modules/zedbee/dist/cli.cjs");
    await rm(join(repo.root, root, "node_modules"), { recursive: true });
    await repo.write("change.txt", "staged\n");
    await repo.git(["add", "change.txt"]);
    const before = (await repo.git(["rev-parse", "HEAD"])).stdout;
    const result = await repo.git(["commit", "-m", "must stop"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("No scan ran.");
    expect(result.stderr).toContain("Restore this checkout's dependencies");
    expect(result.stderr).not.toContain("MODULE_NOT_FOUND");
    expect((await repo.git(["rev-parse", "HEAD"])).stdout).toBe(before);
    await expect(repo.read("should-not-run")).rejects.toMatchObject({
      code: "ENOENT",
    });
    const missing = await execa("sh", ["-c", command], {
      cwd: repo.root,
      reject: false,
    });
    expect(missing.exitCode).toBe(2);
    expect(missing.stderr.split("\n")).toHaveLength(3);
    // A directory at the entry point must also be rejected before Node starts.
    await mkdir(cli, { recursive: true });
    expect(
      (await execa("sh", ["-c", command], { cwd: repo.root, reject: false }))
        .exitCode,
    ).toBe(2);
    await rm(cli, { recursive: true });
    await installed(repo, root);
    expect((await repo.git(["hook", "run", "pre-commit"])).exitCode).toBe(0);
    await repo.write(
      `${root === "." ? "" : root + "/"}node_modules/zedbee/dist/cli.cjs`,
      "process.exit(23);",
    );
    const failure = await execa("sh", ["-c", command], {
      cwd: repo.root,
      reject: false,
    });
    expect(failure.exitCode).toBe(23);
    expect(failure.stderr).not.toContain("No scan ran.");
  },
);

it.each(["raw", "husky", "lefthook", "simple-git-hooks"] as const)(
  "refreshes guarded %s hooks without duplication and preserves merge behavior",
  async (manager) => {
    const repo = await createGitRepository();
    await installed(repo, "web");
    const { mergeHookCommand, hasZedbeeScanCommand } =
      await import("../../src/hooks/husky.js");
    const command = await resolveHookCommand(repo.root);
    const merge = mergeHookCommand(command);
    expect(hasZedbeeScanCommand(merge, "pre-merge-commit")).toBe(true);
    for (const previous of [
      command,
      "(cd \"$(git rev-parse --show-toplevel)\" && node './web/node_modules/zedbee/dist/cli.cjs' scan --hook-invocation)",
    ]) {
      const update = (source: string) => {
        if (manager === "lefthook")
          return updateLefthookConfig(source, merge, "pre-merge-commit");
        if (manager === "simple-git-hooks")
          return updateSimpleGitHooksManifest(
            source,
            merge,
            "pre-merge-commit",
          );
        return updateHuskyHook(source, merge, "pre-merge-commit");
      };
      const oldMerge = mergeHookCommand(previous);
      const source =
        manager === "lefthook"
          ? `pre-merge-commit:\n  commands:\n    zedbee:\n      run: ${JSON.stringify(oldMerge)}\n`
          : manager === "simple-git-hooks"
            ? JSON.stringify({
                "simple-git-hooks": { "pre-merge-commit": oldMerge },
              })
            : `#!/bin/sh\n${oldMerge}\n`;
      const updated = update(source);
      expect(update(updated)).toBe(updated);
      const run =
        manager === "lefthook"
          ? parseYaml(updated)["pre-merge-commit"].commands.zedbee.run
          : manager === "simple-git-hooks"
            ? JSON.parse(updated)["simple-git-hooks"]["pre-merge-commit"]
            : updated;
      const result = await execa("sh", ["-c", run], {
        cwd: repo.root,
        reject: false,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      expect(JSON.parse(await repo.read("hook-result.json")).args).toEqual([
        "scan",
        "--hook-invocation",
        "--merge",
      ]);
      await rm(join(repo.root, "web/node_modules"), { recursive: true });
      const absent = await execa("sh", ["-c", run], {
        cwd: repo.root,
        reject: false,
      });
      expect(absent.exitCode).toBe(2);
      expect(absent.stderr).toContain("Retry the merge");
      await installed(repo, "web");
    }
  },
);

it("uses the linked worktree's installation rather than the main checkout", async () => {
  const repo = await createGitRepository();
  await repo.write(".gitignore", "node_modules/\n");
  await installed(repo, "web");
  await repo.commitAll("baseline");
  const command = await resolveHookCommand(repo.root);
  const other = join(repo.root, "other-checkout");
  expect(
    (await repo.git(["worktree", "add", "--detach", other, "HEAD"])).exitCode,
  ).toBe(0);
  const result = await execa("sh", ["-c", command], {
    cwd: other,
    reject: false,
  });
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("No scan ran.");
  await expect(repo.read("hook-result.json")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it.each(["pre-commit", "pre-merge-commit"] as const)(
  "migrates a stock previous direct-Node %s hook while refusing custom execution",
  async (hookName) => {
    const repo = await createGitRepository();
    await installed(repo, "web");
    const { validateLocalHookMigration } =
      await import("../../src/hooks/install.js");
    const command = await resolveHookCommand(repo.root);
    const legacy = `(cd "$(git rev-parse --show-toplevel)" && node './web/node_modules/zedbee/dist/cli.cjs' scan --hook-invocation${hookName === "pre-merge-commit" ? " --merge" : ""})`;
    const path = `.git/hooks/${hookName}`;
    await repo.write(path, `#!/bin/sh\n${legacy} || exit $?\n`);
    await chmod(join(repo.root, path), 0o755);
    await expect(
      validateLocalHookMigration(repo.root, command),
    ).resolves.toBeUndefined();
    await repo.write(path, `#!/bin/sh\nprintf custom\n${legacy} || exit $?\n`);
    await expect(
      validateLocalHookMigration(repo.root, command),
    ).rejects.toThrow("custom local hook");
  },
);
