import { parse as parseYaml } from "yaml";
import { updateHuskyHook } from "../../src/hooks/husky.js";
import { updateLefthookConfig } from "../../src/hooks/lefthook.js";
import { updateSimpleGitHooksManifest } from "../../src/hooks/simple-git-hooks.js";
import { chmod, realpath } from "node:fs/promises";
import { join } from "node:path";
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
