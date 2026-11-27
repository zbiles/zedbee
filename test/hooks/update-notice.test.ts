import {
  chmod,
  mkdir,
  realpath,
  readFile,
  symlink,
  unlink,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { createGitRepository } from "../helpers/git-repository.js";
import { resolveHookCommand } from "../../src/hooks/command.js";
import { mergeHookCommand, updateHuskyHook } from "../../src/hooks/husky.js";
import { inspectHookMaintenance } from "../../src/hooks/update-notice.js";
import { defaultDiagnosticProbe } from "../../src/doctor/diagnostics.js";

const getHookUpdateNotice = async (root: string) =>
  (await inspectHookMaintenance(root)).hookUpdate;

const old = "npx --no-install zedbee scan --hook-invocation";

async function fixture() {
  const repo = await createGitRepository();
  await repo.write(".gitignore", "node_modules/\n");
  await repo.write("web/package.json", '{"devDependencies":{"zedbee":"*"}}');
  await repo.write(
    "web/node_modules/zedbee/package.json",
    '{"name":"zedbee","bin":"dist/cli.js"}',
  );
  await repo.write(
    "web/node_modules/zedbee/dist/cli.js",
    "throw new Error('must never run');",
  );
  return repo;
}

it.each(["pre-commit", "pre-merge-commit"])(
  "detects an old %s command until refreshed without changing files",
  async (hook) => {
    const repo = await fixture();
    const before = `#!/bin/sh\nnpm test\n${old}${hook === "pre-merge-commit" ? " --merge" : ""} || exit $?\n`;
    await repo.write(`.git/hooks/${hook}`, before);
    expect(await getHookUpdateNotice(repo.root)).toMatchObject({
      code: "HOOK_UPDATE_NEEDED",
      remediation: "Run zedbee init to refresh them.",
    });
    expect(await repo.read(`.git/hooks/${hook}`)).toBe(before);
    expect(await getHookUpdateNotice(repo.root)).toBeDefined();
    const current = await resolveHookCommand(repo.root);
    await repo.write(
      `.git/hooks/${hook}`,
      updateHuskyHook(
        before,
        hook === "pre-commit" ? current : mergeHookCommand(current),
        hook as "pre-commit" | "pre-merge-commit",
      ),
    );
    expect(await getHookUpdateNotice(repo.root)).toBeUndefined();
  },
);

it.each(["husky", "custom", "lefthook", "simple-git-hooks"])(
  "finds stale generated commands in %s",
  async (manager) => {
    const repo = await fixture();
    const current = await resolveHookCommand(repo.root);
    if (manager === "husky" || manager === "custom") {
      const path = manager === "husky" ? ".husky" : ".hooks";
      await repo.git(["config", "core.hooksPath", path]);
      await repo.write(`${path}/pre-commit`, old + "\n");
      await chmod(join(repo.root, path, "pre-commit"), 0o755);
      expect(await getHookUpdateNotice(repo.root)).toBeDefined();
      await repo.write(`${path}/pre-commit`, current + "\n");
    } else if (manager === "lefthook") {
      await repo.write(
        "lefthook.yml",
        `pre-commit:\n  commands:\n    scan:\n      run: ${JSON.stringify(old)}\n`,
      );
      expect(await getHookUpdateNotice(repo.root)).toBeDefined();
      await repo.write(
        "lefthook.yml",
        `pre-commit:\n  commands:\n    scan:\n      run: ${JSON.stringify(current)}\n`,
      );
    } else {
      await repo.write(
        "package.json",
        JSON.stringify({ "simple-git-hooks": { "pre-commit": old } }),
      );
      expect(await getHookUpdateNotice(repo.root)).toBeDefined();
      await repo.write(
        "package.json",
        JSON.stringify({ "simple-git-hooks": { "pre-commit": current } }),
      );
    }
    expect(await getHookUpdateNotice(repo.root)).toBeUndefined();
  },
);

it("finds a stale installed simple-git-hooks copy even when its configuration is current", async () => {
  const repo = await fixture();
  await repo.write(
    "package.json",
    JSON.stringify({
      "simple-git-hooks": { "pre-commit": await resolveHookCommand(repo.root) },
    }),
  );
  await repo.write(".git/hooks/pre-commit", old + "\n");
  expect(await getHookUpdateNotice(repo.root)).toBeDefined();
});

it("ignores unused manager configs when init selects a custom hooks path", async () => {
  const repo = await fixture();
  await repo.git(["config", "core.hooksPath", ".hooks"]);
  await repo.write(
    ".hooks/pre-commit",
    (await resolveHookCommand(repo.root)) + "\n",
  );
  await repo.write(
    "lefthook.yml",
    `pre-commit:\n  commands:\n    scan:\n      run: ${JSON.stringify(old)}\n`,
  );
  await repo.write(
    "package.json",
    JSON.stringify({ "simple-git-hooks": { "pre-commit": old } }),
  );
  expect(await getHookUpdateNotice(repo.root)).toBeUndefined();
});

it("follows init's preferred Lefthook filename rather than inspecting an unused second config", async () => {
  const repo = await fixture();
  await repo.write(
    "lefthook.yaml",
    `pre-commit:\n  commands:\n    scan:\n      run: ${JSON.stringify(await resolveHookCommand(repo.root))}\n`,
  );
  await repo.write(
    "lefthook.yml",
    `pre-commit:\n  commands:\n    scan:\n      run: ${JSON.stringify(old)}\n`,
  );
  expect(await getHookUpdateNotice(repo.root)).toBeUndefined();
});

it.each([
  "",
  "# npx --no-install zedbee scan\n",
  "node ./custom-hook.js\n",
  "npx --no-install zedbee scan --config team.jsonc\n",
])(
  "does not classify missing, commented or customized commands as stale: %s",
  async (source) => {
    const repo = await fixture();
    await repo.write(".git/hooks/pre-commit", source);
    expect(await getHookUpdateNotice(repo.root)).toBeUndefined();
  },
);

it("ignores unsupported external hook paths, symlinks, oversized files and malformed manager data", async () => {
  const repo = await fixture();
  await repo.write("oversized", old + "\n" + "#".repeat(70_000));
  await symlink(
    join(repo.root, "oversized"),
    join(repo.root, ".git/hooks/pre-commit"),
  );
  await repo.write("lefthook.yml", "pre-commit: [");
  await repo.write("package.json", "broken");
  expect(await getHookUpdateNotice(repo.root)).toBeUndefined();
  await repo.git(["config", "core.hooksPath", "/external/unsupported/hooks"]);
  expect(await getHookUpdateNotice(repo.root)).toBeUndefined();
});

it("does not fail when Swarm's selected installation is missing", async () => {
  const repo = await createGitRepository();
  await repo.write(".git/hooks/pre-commit", old);
  expect(await getHookUpdateNotice(repo.root)).toBeUndefined();
});

it("inspects shared raw hooks from a linked worktree", async () => {
  const repo = await fixture();
  await repo.commitAll("baseline");
  const linked = join(repo.root, "linked");
  expect(
    (await repo.git(["worktree", "add", "-b", "linked", linked])).exitCode,
  ).toBe(0);
  await mkdir(join(linked, "web/node_modules"), { recursive: true });
  await symlink(
    await realpath(join(repo.root, "web/node_modules/zedbee")),
    join(linked, "web/node_modules/zedbee"),
  );
  await repo.write(".git/hooks/pre-commit", old + "\n");
  expect(await getHookUpdateNotice(linked)).toBeDefined();
});

it("doctor reports an outdated hook as a warning rather than healthy", async () => {
  const repo = await fixture();
  await repo.write(".git/hooks/pre-commit", old + "\n");
  await chmod(join(repo.root, ".git/hooks/pre-commit"), 0o755);
  const context = { cwd: repo.root, environment: {} };
  expect(await defaultDiagnosticProbe("hook-state", context)).toMatchObject({
    status: "warning",
    message: "Swarm’s hooks need updating.",
    remediation: "Run zedbee init to refresh them.",
  });
  await repo.write(
    ".git/hooks/pre-commit",
    (await resolveHookCommand(repo.root)) + "\n",
  );
  expect((await defaultDiagnosticProbe("hook-state", context)).status).toBe(
    "pass",
  );
});

it("diagnoses an unreachable Husky body and its installation independently", async () => {
  const repo = await fixture();
  await repo.git(["config", "core.hooksPath", ".husky/_"]);
  const command = await resolveHookCommand(repo.root);
  await repo.write(".husky/pre-commit", updateHuskyHook(null, command));
  const context = { cwd: repo.root, environment: {} };
  expect(await getHookUpdateNotice(repo.root)).toMatchObject({
    code: "HUSKY_DISPATCHER_INACTIVE",
  });
  expect(await defaultDiagnosticProbe("hook-state", context)).toMatchObject({
    status: "warning",
    message: expect.stringContaining("dispatcher is missing or inactive"),
  });
  expect(
    (await inspectHookMaintenance(repo.root, true)).hookUpdate,
  ).toBeUndefined();
  expect(
    await defaultDiagnosticProbe("hook-state", {
      ...context,
      environment: { HUSKY: "0" },
    }),
  ).toMatchObject({
    status: "warning",
    message: "Husky is explicitly disabled in this environment.",
  });
  await repo.write(
    ".husky/_/pre-commit",
    '#!/usr/bin/env sh\n. "$(dirname "$0")/h"\n',
  );
  await chmod(join(repo.root, ".husky/_/pre-commit"), 0o755);
  // A linked helper must not be mistaken for a reachable trusted dispatcher.
  await symlink(
    join(repo.root, ".husky/pre-commit"),
    join(repo.root, ".husky/_/h"),
  );
  expect(await getHookUpdateNotice(repo.root)).toMatchObject({
    code: "HUSKY_DISPATCHER_INACTIVE",
  });
  await unlink(join(repo.root, ".husky/_/h"));
  await repo.write(".husky/_/h", "");
  await repo.write(
    "web/node_modules/zedbee/dist/cli.js",
    'require("node:fs").writeFileSync("hook-invoked", "yes");',
  );
  expect((await repo.git(["hook", "run", "pre-commit"])).exitCode).toBe(0);
  await expect(repo.read("hook-invoked")).rejects.toThrow();
  expect(await getHookUpdateNotice(repo.root)).toMatchObject({
    code: "HUSKY_DISPATCHER_INACTIVE",
  });
  await repo.write(".husky/_/h", "#!/bin/sh\n");
  expect(await getHookUpdateNotice(repo.root)).toMatchObject({
    code: "HUSKY_RUNTIME_UNVERIFIED",
  });
  const stock = await readFile(
    join(dirname(fileURLToPath(import.meta.resolve("husky"))), "husky"),
    "utf8",
  );
  await repo.write(".husky/_/h", stock);
  expect((await repo.git(["hook", "run", "pre-commit"])).exitCode).toBe(0);
  expect(await repo.read("hook-invoked")).toBe("yes");
  const beta21 = `#!/bin/sh\nnpm test\n${command} || exit $?\n`;
  await repo.write(".husky/pre-commit", beta21);
  expect(await getHookUpdateNotice(repo.root)).toMatchObject({
    code: "HOOK_UPDATE_NEEDED",
  });
  await repo.write(".husky/pre-commit", updateHuskyHook(beta21, command));
  expect(await getHookUpdateNotice(repo.root)).toBeUndefined();
  await unlink(join(repo.root, "web/node_modules/zedbee/dist/cli.js"));
  expect(await getHookUpdateNotice(repo.root)).toMatchObject({
    code: "HUSKY_CLI_UNAVAILABLE",
  });
  expect(await defaultDiagnosticProbe("hook-state", context)).toMatchObject({
    status: "warning",
    message: expect.stringContaining("usable installation in this checkout"),
  });
});

it("lets an active raw hook take precedence over a leftover Husky body", async () => {
  const repo = await fixture();
  const command = await resolveHookCommand(repo.root);
  await repo.write(".husky/pre-commit", old + "\n");
  await repo.write(".git/hooks/pre-commit", command + "\n");
  await chmod(join(repo.root, ".git/hooks/pre-commit"), 0o755);

  expect(await getHookUpdateNotice(repo.root)).toBeUndefined();
  expect(
    await defaultDiagnosticProbe("hook-state", {
      cwd: repo.root,
      environment: {},
    }),
  ).toMatchObject({ status: "pass" });
});
