import {
  chmod,
  cp,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { parse as parseYaml } from "yaml";
import { describe, expect, it, onTestFinished } from "vitest";
import { resolveHookCommand } from "../../src/hooks/command.js";
import {
  detectHookIntegration,
  type DetectedHookIntegration,
} from "../../src/hooks/detect.js";
import { installTrackedHooks } from "../../src/hooks/install.js";
import { updateRawGitHook } from "../../src/hooks/raw-git.js";
import { initFileChange } from "../../src/init/recommend.js";
import { applyInitProposal } from "../../src/init/write-config.js";
import type { InitProposal } from "../../src/init/types.js";
import {
  createGitRepository,
  type TestGitRepository,
} from "../helpers/git-repository.js";

async function installation(repository: TestGitRepository) {
  await repository.write(
    "package.json",
    '{"name":"fixture","devDependencies":{"zedbee":"*"}}',
  );
  await repository.write(
    "node_modules/zedbee/package.json",
    '{"name":"zedbee","bin":{"zedbee":"dist/cli.cjs"}}',
  );
  await repository.write(
    "node_modules/zedbee/dist/cli.cjs",
    `require('node:fs').appendFileSync('hook-result.jsonl', JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2)})+'\\n');`,
  );
  return resolveHookCommand(repository.root);
}

function proposal(
  root: string,
  integration: DetectedHookIntegration,
): InitProposal {
  return {
    repositoryRoot: root,
    profile: "recommended",
    hook: integration.hook,
    hookActivation: integration.activation,
    ...(integration.hooksPathChange === undefined
      ? {}
      : { hooksPathChange: integration.hooksPathChange }),
    detectedEnvironments: [],
    recommendedChecks: [],
    vulnerabilityScanningAvailable: false,
    osvUnavailable: "block",
    networkChecks: [],
    limitations: [],
    files: [
      ...(integration.change ? [integration.change] : []),
      ...(integration.changes ?? []),
    ],
  };
}

async function invocations(repository: TestGitRepository) {
  return (await repository.read("hook-result.jsonl"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

async function run(
  repository: TestGitRepository,
  name: "pre-commit" | "pre-merge-commit",
) {
  const result = await repository.git(["hook", "run", name]);
  expect(result.exitCode, result.stderr).toBe(0);
}

describe("both commit hook setup", () => {
  it("resolves a merge hook invocation from the same installed CLI", async () => {
    const repo = await createGitRepository();
    await installation(repo);
    const command = await resolveHookCommand(repo.root, "pre-merge-commit");
    await repo.write(
      ".git/hooks/pre-merge-commit",
      updateRawGitHook(null, command),
    );
    await chmod(join(repo.root, ".git/hooks/pre-merge-commit"), 0o755);
    await run(repo, "pre-merge-commit");
    expect((await invocations(repo))[0].args).toEqual([
      "scan",
      "--hook-invocation",
      "--merge",
    ]);
  });

  it.each(["raw", "custom", "husky", "tracked"] as const)(
    "installs both %s hooks, preserves commands, and reinitializes once",
    async (choice) => {
      const repo = await createGitRepository();
      const command = await installation(repo);
      const directory =
        choice === "custom"
          ? "scripts/hooks"
          : choice === "husky" || choice === "tracked"
            ? ".husky"
            : ".git/hooks";
      if (choice === "custom" || choice === "husky")
        await repo.git(["config", "core.hooksPath", directory]);
      if (choice !== "tracked") {
        for (const name of ["pre-commit", "pre-merge-commit"]) {
          await repo.write(
            `${directory}/${name}`,
            `#!/bin/sh\nprintf '${name}\\n' >> preserved.txt\n`,
          );
          await chmod(join(repo.root, directory, name), 0o755);
        }
      }
      const first = await detectHookIntegration(repo.root, choice, command);
      await applyInitProposal(proposal(repo.root, first));
      const second = await detectHookIntegration(repo.root, choice, command);
      await applyInitProposal(proposal(repo.root, second));
      expect(second.activation.status).toBe("active");
      await run(repo, "pre-commit");
      await run(repo, "pre-merge-commit");
      const called = await invocations(repo);
      expect(called.map(({ args }) => args)).toEqual([
        ["scan", "--hook-invocation"],
        ["scan", "--hook-invocation", "--merge"],
      ]);
      const root = await realpath(repo.root);
      expect(called.every(({ cwd }) => cwd === root)).toBe(true);
      if (choice !== "tracked")
        expect(await repo.read("preserved.txt")).toBe(
          "pre-commit\npre-merge-commit\n",
        );
    },
  );

  it.each(["lefthook", "simple-git-hooks"] as const)(
    "preserves and executes both %s configurations",
    async (choice) => {
      const repo = await createGitRepository();
      const command = await installation(repo);
      if (choice === "lefthook") {
        await repo.write(
          "lefthook.yml",
          "# retain\npre-commit:\n  commands:\n    original:\n      run: printf commit\npre-merge-commit:\n  commands:\n    original:\n      run: printf merge\n",
        );
      } else {
        await repo.write(
          "package.json",
          '{"name":"fixture","devDependencies":{"zedbee":"*"},"scripts":{"test":"original"},"simple-git-hooks":{"pre-commit":"printf commit","pre-merge-commit":"printf merge"}}',
        );
      }
      const first = await detectHookIntegration(repo.root, choice, command);
      expect(first.activation.status).toBe("pending");
      await applyInitProposal(proposal(repo.root, first));
      const second = await detectHookIntegration(repo.root, choice, command);
      await applyInitProposal(proposal(repo.root, second));
      for (const name of ["pre-commit", "pre-merge-commit"] as const) {
        const source =
          choice === "lefthook"
            ? await repo.read("lefthook.yml")
            : await repo.read("package.json");
        if (choice === "lefthook") {
          const data = parseYaml(source);
          expect(data[name].commands.original.run).toBe(
            name === "pre-commit" ? "printf commit" : "printf merge",
          );
          expect(source).toContain("# retain");
          await repo.write(
            `.git/hooks/${name}`,
            `#!/bin/sh\n${data[name].commands.zedbee.run}\n`,
          );
        } else {
          const manifest = JSON.parse(source);
          expect(manifest.scripts.test).toBe("original");
          await repo.write(
            `.git/hooks/${name}`,
            `#!/bin/sh\n${manifest["simple-git-hooks"][name]}\n`,
          );
        }
        await chmod(join(repo.root, ".git/hooks", name), 0o755);
        await run(repo, name);
      }
      expect((await invocations(repo)).map(({ args }) => args)).toEqual([
        ["scan", "--hook-invocation"],
        ["scan", "--hook-invocation", "--merge"],
      ]);
    },
  );

  it.each(["husky", "lefthook", "simple-git-hooks"] as const)(
    "reports %s pending if only pre-commit is active",
    async (choice) => {
      const repo = await createGitRepository();
      const command = await installation(repo);
      const directory = choice === "husky" ? ".husky/_" : ".git/hooks";
      if (choice === "husky") {
        await repo.git(["config", "core.hooksPath", directory]);
        await repo.write(".husky/_/h", "fixture runtime");
      }
      await repo.write(
        `${directory}/pre-commit`,
        `#!/bin/sh\n${choice === "husky" ? ' . "$(dirname "$0")/h"' : choice === "lefthook" ? "lefthook run pre-commit" : command}\n`,
      );
      await chmod(join(repo.root, directory, "pre-commit"), 0o755);
      expect(
        (await detectHookIntegration(repo.root, choice, command)).activation
          .status,
      ).toBe("pending");
    },
  );

  it("does not claim a disabled installed merge hook is active", async () => {
    if (process.platform === "win32") return;
    const repo = await createGitRepository();
    const command = await installation(repo);
    for (const name of ["pre-commit", "pre-merge-commit"]) {
      await repo.write(
        `.git/hooks/${name}`,
        `#!/bin/sh\nlefthook run ${name}\n`,
      );
      await chmod(
        join(repo.root, ".git/hooks", name),
        name === "pre-commit" ? 0o755 : 0o644,
      );
    }
    expect(
      (await detectHookIntegration(repo.root, "lefthook", command)).activation
        .status,
    ).toBe("pending");
  });

  it("upgrades both generated local hooks to tracked setup", async () => {
    const repo = await createGitRepository();
    const command = await installation(repo);
    await applyInitProposal(
      proposal(
        repo.root,
        await detectHookIntegration(repo.root, "raw", command),
      ),
    );
    await applyInitProposal(
      proposal(
        repo.root,
        await detectHookIntegration(repo.root, "tracked", command),
      ),
    );
    await run(repo, "pre-merge-commit");
    expect((await invocations(repo))[0].args).toEqual([
      "scan",
      "--hook-invocation",
      "--merge",
    ]);
  });

  it("preserves custom scan invocations while adding merge coverage", async () => {
    const repo = await createGitRepository();
    const command = await installation(repo);
    await repo.write(
      ".git/hooks/pre-merge-commit",
      "#!/bin/sh\nnpx --no-install zedbee scan --format json\n",
    );
    const integration = await detectHookIntegration(repo.root, "raw", command);
    const merge = integration.changes!.find(
      (change) => change.relativePath === ".git/hooks/pre-merge-commit",
    )!;
    expect(merge.after).toContain("npx --no-install zedbee scan --format json");
    expect(merge.after).toContain(" scan --hook-invocation --merge)");
  });

  it("preserves a merge hook delegating to the newly updated pre-commit hook", async () => {
    const repo = await createGitRepository();
    const command = await installation(repo);
    const delegation =
      '#!/bin/sh\nexec "$(git rev-parse --git-path hooks/pre-commit)"\n';
    await repo.write(".git/hooks/pre-merge-commit", delegation);
    await chmod(join(repo.root, ".git/hooks/pre-merge-commit"), 0o755);
    const integration = await detectHookIntegration(repo.root, "raw", command);
    await applyInitProposal(proposal(repo.root, integration));
    expect(integration.changes).toHaveLength(1);
    expect(await repo.read(".git/hooks/pre-merge-commit")).toBe(delegation);
    await run(repo, "pre-merge-commit");
    expect(await invocations(repo)).toHaveLength(1);
  });

  it("rolls back pre-commit if writing pre-merge-commit fails", async () => {
    const repo = await createGitRepository();
    const command = await installation(repo);
    const before = "#!/bin/sh\nprintf original\n";
    await repo.write(".git/hooks/pre-commit", before);
    const integration = await detectHookIntegration(repo.root, "raw", command);
    await expect(
      applyInitProposal(proposal(repo.root, integration), {
        beforeWrite(_index, change) {
          if (change.relativePath.endsWith("pre-merge-commit"))
            throw new Error("fixture failure");
        },
      }),
    ).rejects.toThrow("rolled back");
    expect(await repo.read(".git/hooks/pre-commit")).toBe(before);
    await expect(
      repo.read(".git/hooks/pre-merge-commit"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a merge-hook symlink before changing either hook", async () => {
    const repo = await createGitRepository();
    const command = await installation(repo);
    await repo.write("outside.txt", "private");
    await symlink(
      join(repo.root, "outside.txt"),
      join(repo.root, ".git/hooks/pre-merge-commit"),
    );
    await expect(
      detectHookIntegration(repo.root, "raw", command),
    ).rejects.toThrow("unsafe hook target");
    expect(await repo.read("outside.txt")).toBe("private");
    await expect(repo.read(".git/hooks/pre-commit")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("validates the merge destination again when applying a proposal", async () => {
    const repo = await createGitRepository();
    const command = await installation(repo);
    const integration = await detectHookIntegration(repo.root, "raw", command);
    const changes = proposal(repo.root, integration).files;
    const merge = changes.find((change) =>
      change.relativePath.endsWith("pre-merge-commit"),
    )!;
    const forged = initFileChange(
      ".git/hooks/pre-merge-commit",
      null,
      merge.after,
      0o755,
      join(repo.root, "outside.txt"),
    );
    await expect(
      applyInitProposal({
        ...proposal(repo.root, integration),
        files: [changes[0]!, forged],
      }),
    ).rejects.toThrow("unsafe initialization target");
    await expect(repo.read(".git/hooks/pre-commit")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("installs the common merge hook from a linked worktree", async () => {
    const repo = await createGitRepository();
    const command = await installation(repo);
    await repo.commitAll("fixture");
    const linked = await mkdtemp(join(tmpdir(), "zedbee-merge-linked-"));
    await rm(linked, { recursive: true, force: true });
    onTestFinished(() => rm(linked, { recursive: true, force: true }));
    expect(
      (await repo.git(["worktree", "add", "-b", "linked", linked])).exitCode,
    ).toBe(0);
    await cp(join(repo.root, "node_modules"), join(linked, "node_modules"), {
      recursive: true,
    });
    const integration = await detectHookIntegration(linked, "raw", command);
    await applyInitProposal(proposal(linked, integration));
    expect(
      await readFile(join(repo.root, ".git/hooks/pre-merge-commit"), "utf8"),
    ).toContain("--merge");
    const merge = integration.changes!.find((change) =>
      change.relativePath.endsWith("pre-merge-commit"),
    )!;
    expect(merge.absolutePath).toBe(
      await realpath(join(repo.root, ".git/hooks/pre-merge-commit")),
    );
    const invoked = await execa("git", ["hook", "run", "pre-merge-commit"], {
      cwd: linked,
      reject: false,
    });
    expect(invoked.exitCode, invoked.stderr).toBe(0);
    const recorded = JSON.parse(
      (await readFile(join(linked, "hook-result.jsonl"), "utf8")).trim(),
    );
    expect(recorded).toEqual({
      cwd: await realpath(linked),
      args: ["scan", "--hook-invocation", "--merge"],
    });
  });

  it("reinstalls tracked merge dispatchers without executing project hooks", async () => {
    const repo = await createGitRepository();
    await repo.write(".husky/pre-merge-commit", "#!/bin/sh\nexit 17\n");
    await installTrackedHooks(repo.root);
    await chmod(join(repo.root, ".husky/_/pre-merge-commit"), 0o644);
    await installTrackedHooks(repo.root);
    expect((await repo.git(["hook", "run", "pre-merge-commit"])).exitCode).toBe(
      17,
    );
  });
});

it.each(["husky", "lefthook", "simple-git-hooks"] as const)(
  "refreshes a generated %s merge command without another scan",
  async (choice) => {
    const repo = await createGitRepository();
    const command = await installation(repo);
    const previous = "npx --no-install zedbee scan --hook-invocation --merge";
    if (choice === "husky") {
      await repo.write(".husky/pre-merge-commit", `#!/bin/sh\n${previous}\n`);
      await repo.git(["config", "core.hooksPath", ".husky"]);
    } else if (choice === "lefthook") {
      await repo.write(
        "lefthook.yml",
        `pre-merge-commit:\n  commands:\n    previous:\n      run: ${previous}\n`,
      );
    } else {
      await repo.write(
        "package.json",
        JSON.stringify({
          name: "fixture",
          devDependencies: { zedbee: "*" },
          "simple-git-hooks": { "pre-merge-commit": previous },
        }),
      );
    }
    await applyInitProposal(
      proposal(
        repo.root,
        await detectHookIntegration(repo.root, choice, command),
      ),
    );
    let hook: string;
    if (choice === "husky") hook = await repo.read(".husky/pre-merge-commit");
    else if (choice === "lefthook") {
      const entries = Object.values(
        parseYaml(await repo.read("lefthook.yml"))["pre-merge-commit"].commands,
      ) as Array<{ run: string }>;
      expect(entries).toHaveLength(1);
      hook = `#!/bin/sh\n${entries[0]!.run}\n`;
    } else
      hook = `#!/bin/sh\n${JSON.parse(await repo.read("package.json"))["simple-git-hooks"]["pre-merge-commit"]}\n`;
    const result = await execa("sh", ["-c", hook], {
      cwd: repo.root,
      reject: false,
    });
    expect(result.exitCode, result.stderr).toBe(0);
    expect((await invocations(repo)).map(({ args }) => args)).toEqual([
      ["scan", "--hook-invocation", "--merge"],
    ]);
  },
);

it("preserves a custom Lefthook command named zedbee when adding merge coverage", async () => {
  const repo = await createGitRepository();
  const command = await installation(repo);
  await repo.write(
    "lefthook.yml",
    "pre-merge-commit:\n  commands:\n    zedbee:\n      run: npx --no-install zedbee scan --format json\n",
  );
  const integration = await detectHookIntegration(
    repo.root,
    "lefthook",
    command,
  );
  const entries = parseYaml(integration.change!.after)["pre-merge-commit"]
    .commands;
  expect(entries.zedbee.run).toBe("npx --no-install zedbee scan --format json");
  expect(Object.values(entries)).toHaveLength(2);
});

it("updates a legacy generated Lefthook merge command under its existing name", async () => {
  const repo = await createGitRepository();
  const command = await installation(repo);
  await repo.write(
    "lefthook.yml",
    "pre-merge-commit:\n  commands:\n    previous:\n      run: npx --no-install zedbee scan --hook-invocation\n",
  );
  const integration = await detectHookIntegration(
    repo.root,
    "lefthook",
    command,
  );
  const entries = parseYaml(integration.change!.after)["pre-merge-commit"]
    .commands;
  expect(Object.values(entries)).toHaveLength(1);
  const result = await execa("sh", ["-c", entries.previous.run], {
    cwd: repo.root,
    reject: false,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  expect((await invocations(repo))[0].args).toEqual([
    "scan",
    "--hook-invocation",
    "--merge",
  ]);
});

it("preserves custom-path delegation without appending a duplicate merge scan", async () => {
  const repo = await createGitRepository();
  const command = await installation(repo);
  await repo.git(["config", "core.hooksPath", "scripts/hooks"]);
  const delegation = "#!/bin/sh\nsh './scripts/hooks/pre-commit'\n";
  await repo.write("scripts/hooks/pre-merge-commit", delegation);
  await chmod(join(repo.root, "scripts/hooks/pre-merge-commit"), 0o755);
  await applyInitProposal(
    proposal(
      repo.root,
      await detectHookIntegration(repo.root, "custom", command),
    ),
  );
  await run(repo, "pre-merge-commit");
  expect(await invocations(repo)).toHaveLength(1);
  expect(await repo.read("scripts/hooks/pre-merge-commit")).toBe(delegation);
});

it("adds merge coverage when an existing hook invokes a different pre-commit file", async () => {
  const repo = await createGitRepository();
  const command = await installation(repo);
  await repo.write(".husky/pre-commit", "#!/bin/sh\nprintf custom\n");
  await repo.write(
    ".git/hooks/pre-merge-commit",
    "#!/bin/sh\nsh .husky/pre-commit\n",
  );
  await chmod(join(repo.root, ".git/hooks/pre-merge-commit"), 0o755);
  await applyInitProposal(
    proposal(repo.root, await detectHookIntegration(repo.root, "raw", command)),
  );
  await run(repo, "pre-merge-commit");
  expect((await invocations(repo))[0].args).toEqual([
    "scan",
    "--hook-invocation",
    "--merge",
  ]);
});

it.each(["raw", "husky", "simple-git-hooks"] as const)(
  "keeps a failing %s merge scan blocking before a preserved exit 0",
  async (choice) => {
    const repo = await createGitRepository();
    const command = await installation(repo);
    await repo.write("node_modules/zedbee/dist/cli.cjs", "process.exit(23);");
    const existing =
      "#!/bin/sh\nprintf original > original-command.txt\nexit 0\n";
    if (choice === "simple-git-hooks") {
      await repo.write(
        "package.json",
        JSON.stringify({
          name: "fixture",
          devDependencies: { zedbee: "*" },
          "simple-git-hooks": { "pre-merge-commit": existing },
        }),
      );
    } else {
      const directory = choice === "husky" ? ".husky" : ".git/hooks";
      await repo.write(`${directory}/pre-merge-commit`, existing);
      if (choice === "husky")
        await repo.git(["config", "core.hooksPath", directory]);
    }
    const first = await detectHookIntegration(repo.root, choice, command);
    await applyInitProposal(proposal(repo.root, first));
    const second = await detectHookIntegration(repo.root, choice, command);
    await applyInitProposal(proposal(repo.root, second));
    if (choice === "simple-git-hooks") {
      const body = JSON.parse(await repo.read("package.json"))[
        "simple-git-hooks"
      ]["pre-merge-commit"];
      await repo.write(".git/hooks/pre-merge-commit", body);
    }
    const path =
      choice === "husky"
        ? ".husky/pre-merge-commit"
        : ".git/hooks/pre-merge-commit";
    await chmod(join(repo.root, path), 0o755);
    const result = await repo.git(["hook", "run", "pre-merge-commit"]);
    expect(result.exitCode, result.stderr).toBe(23);
    expect(await repo.read("original-command.txt")).toBe("original");
  },
);

it("preserves scan failure when a managed invocation precedes a later custom command", async () => {
  const repo = await createGitRepository();
  const command = await installation(repo);
  await repo.write("node_modules/zedbee/dist/cli.cjs", "process.exit(24);");
  await repo.write(
    ".git/hooks/pre-merge-commit",
    "#!/bin/sh\nnpx --no-install zedbee scan --hook-invocation --merge\nprintf after > after-command.txt\n",
  );
  await applyInitProposal(
    proposal(repo.root, await detectHookIntegration(repo.root, "raw", command)),
  );
  await chmod(join(repo.root, ".git/hooks/pre-merge-commit"), 0o755);
  const result = await repo.git(["hook", "run", "pre-merge-commit"]);
  expect(result.exitCode, result.stderr).toBe(24);
  await expect(repo.read("after-command.txt")).rejects.toMatchObject({
    code: "ENOENT",
  });
});

it("keeps a delegated pre-commit failure blocking before a later exit 0", async () => {
  const repo = await createGitRepository();
  const command = await installation(repo);
  await repo.write(
    "node_modules/zedbee/dist/cli.cjs",
    "require('node:fs').appendFileSync('scan-count.txt', 'run\\n');process.exit(25);",
  );
  await repo.write(
    ".git/hooks/pre-merge-commit",
    '#!/bin/sh\nsh "$(git rev-parse --git-path hooks/pre-commit)"\nexit 0\n',
  );
  await chmod(join(repo.root, ".git/hooks/pre-merge-commit"), 0o755);
  await applyInitProposal(
    proposal(repo.root, await detectHookIntegration(repo.root, "raw", command)),
  );
  await applyInitProposal(
    proposal(repo.root, await detectHookIntegration(repo.root, "raw", command)),
  );
  const result = await repo.git(["hook", "run", "pre-merge-commit"]);
  expect(result.exitCode, result.stderr).toBe(25);
  expect(await repo.read("scan-count.txt")).toBe("run\n");
});
