import { createHash } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyInitProposal } from "../../src/init/write-config.js";
import type { InitProposal } from "../../src/init/types.js";
import { detectHookIntegration } from "../../src/hooks/detect.js";
import { updateHuskyHook } from "../../src/hooks/husky.js";
import { updateLefthookConfig } from "../../src/hooks/lefthook.js";
import { updateSimpleGitHooksManifest } from "../../src/hooks/simple-git-hooks.js";
import { updateRawGitHook } from "../../src/hooks/raw-git.js";
import { createInitProposal } from "../../src/init/recommend.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { createGitRepository } from "../helpers/git-repository.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) =>
      rm(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 50,
      }),
    ),
  );
});

describe("hook manager data writers", () => {
  it.each([
    ["husky", updateHuskyHook],
    ["raw", updateRawGitHook],
  ] as const)(
    "preserves commands around one idempotent Zedbee insertion for %s",
    (_name, update) => {
      const before = "#!/bin/sh\nprintf 'existing hook\\n'\nnpm test\n";
      const once = update(before);
      const twice = update(once);

      expect(twice).toContain("printf 'existing hook\\n'");
      expect(twice.indexOf("printf")).toBeLessThan(
        twice.indexOf("zedbee scan"),
      );
      expect(twice).toContain("npm test");
      expect(twice.match(/zedbee scan/gu) ?? []).toHaveLength(1);
    },
  );

  it("does not treat a commented mention as an installed hook command", () => {
    const updated = updateRawGitHook(
      "#!/bin/sh\n# zedbee scan is intentionally not installed yet\nnpm test\n",
    );

    expect(updated.match(/^[^#\n]*zedbee scan/gmu) ?? []).toHaveLength(1);
  });

  it("inserts before a terminal exit without removing surrounding hook work", () => {
    const updated = updateHuskyHook(
      "#!/bin/sh\nprintf before\nnpm test\nexit 0\n",
    );

    expect(updated.indexOf("npm test")).toBeLessThan(
      updated.indexOf("zedbee scan"),
    );
    expect(updated.indexOf("zedbee scan")).toBeLessThan(
      updated.indexOf("exit 0"),
    );
  });

  it("preserves unrelated Lefthook YAML commands and existing Zedbee entries", () => {
    const before = [
      "pre-commit:",
      "  commands:",
      "    tests:",
      "      run: npm test",
      "    zedbee:",
      "      run: npx zedbee scan",
      "",
    ].join("\n");
    const updated = updateLefthookConfig(before);

    expect(updated).toContain("npm test");
    expect(updated.match(/zedbee scan/gu) ?? []).toHaveLength(1);
  });

  it("preserves Lefthook comments while adding the managed command", () => {
    const before = [
      "# Keep this project guidance.",
      "pre-commit:",
      "  commands:",
      "    tests: # important command",
      "      run: npm test",
      "",
    ].join("\n");

    const updated = updateLefthookConfig(before);

    expect(updated).toContain("# Keep this project guidance.");
    expect(updated).toContain("# important command");
    expect(updated).toContain("npm test");
    expect(updated.match(/zedbee scan/gu) ?? []).toHaveLength(1);
  });

  it("preserves unrelated package data and simple-git-hooks commands", () => {
    const before = `${JSON.stringify(
      {
        name: "fixture",
        scripts: { test: "vitest" },
        "simple-git-hooks": { "pre-commit": "printf before && npm test" },
      },
      null,
      2,
    )}\n`;
    const updated = JSON.parse(updateSimpleGitHooksManifest(before)) as {
      scripts: { test: string };
      "simple-git-hooks": { "pre-commit": string };
    };

    expect(updated.scripts.test).toBe("vitest");
    expect(updated["simple-git-hooks"]["pre-commit"]).toContain(
      "printf before",
    );
    expect(updated["simple-git-hooks"]["pre-commit"]).toContain("npm test");
    expect(
      updated["simple-git-hooks"]["pre-commit"].match(/zedbee scan/gu) ?? [],
    ).toHaveLength(1);
  });
});

describe("detectHookIntegration", () => {
  it.each([
    {
      name: "Husky",
      setup: async (root: string) => {
        await mkdir(join(root, ".husky"));
        await writeFile(
          join(root, ".husky/pre-commit"),
          "#!/bin/sh\nnpm test\n",
        );
        await writeFile(
          join(root, "package.json"),
          '{"devDependencies":{"husky":"9.0.0"}}\n',
        );
      },
      manager: "husky",
      path: ".husky/pre-commit",
    },
    {
      name: "Lefthook",
      setup: async (root: string) => {
        await writeFile(
          join(root, "lefthook.yml"),
          "pre-commit:\n  commands: {}\n",
        );
      },
      manager: "lefthook",
      path: "lefthook.yml",
    },
    {
      name: "simple-git-hooks",
      setup: async (root: string) => {
        await writeFile(
          join(root, "package.json"),
          '{"simple-git-hooks":{"pre-commit":"npm test"}}\n',
        );
      },
      manager: "simple-git-hooks",
      path: "package.json",
    },
  ] as const)(
    "detects and proposes a preserving $name integration",
    async ({ setup, manager, path }) => {
      const root = await mkdtemp(join(tmpdir(), "zedbee-hook-detect-"));
      roots.push(root);
      await setup(root);

      const detected = await detectHookIntegration(root, "auto");

      expect(detected.hook).toBe(manager);
      expect(detected.change?.relativePath).toBe(path);
      expect(detected.change?.after).toContain("zedbee scan");
      if (manager !== "husky") {
        expect(detected.activation.status).toBe("pending");
      }
    },
  );

  it("resolves and safely writes the common Git hook from a linked worktree", async () => {
    const repository = await createGitRepository("zedbee-init-main-");
    await repository.write(
      "package.json",
      '{"name":"fixture","private":true}\n',
    );
    await repository.commitAll("fixture");
    const linked = await mkdtemp(join(tmpdir(), "zedbee-init-linked-"));
    await rm(linked, { recursive: true, force: true });
    roots.push(linked);
    const added = await repository.git([
      "worktree",
      "add",
      "-b",
      "linked",
      linked,
    ]);
    expect(added.exitCode).toBe(0);
    const commonHook = join(repository.root, ".git/hooks/pre-commit");
    await writeFile(commonHook, "#!/bin/sh\nnpm test\n");
    await chmod(commonHook, 0o751);

    const detected = await detectHookIntegration(linked, "auto");
    const proposal = createInitProposal(await inspectRepository(linked), {
      repositoryRoot: linked,
      profile: "recommended",
      hook: detected.hook,
      ...(detected.change === undefined ? {} : { hookChange: detected.change }),
    });
    await applyInitProposal(proposal);

    expect(detected.hook).toBe("raw");
    expect(detected.change?.absolutePath).toBe(await realpath(commonHook));
    expect(await readFile(commonHook, "utf8")).toContain("zedbee scan");
    if (process.platform !== "win32") {
      expect((await lstat(commonHook)).mode & 0o777).toBe(0o751);
    }
  });
});

describe("applyInitProposal", () => {
  it("writes atomically, preserves an existing mode, and returns applied paths", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-init-write-"));
    roots.push(root);
    await mkdir(join(root, ".husky"));
    const hookPath = join(root, ".husky/pre-commit");
    await writeFile(hookPath, "#!/bin/sh\nnpm test\n");
    await chmod(hookPath, 0o751);
    const proposal: InitProposal = {
      repositoryRoot: root,
      profile: "recommended",
      hook: "husky",
      detectedEnvironments: [],
      recommendedChecks: [],
      vulnerabilityScanningAvailable: false,
      osvUnavailable: "block",
      networkChecks: [],
      limitations: [],
      hookActivation: {
        status: "active",
        message: "The proposed hook directly invokes Zedbee.",
      },
      files: [
        {
          relativePath: ".husky/pre-commit",
          before: "#!/bin/sh\nnpm test\n",
          after: "#!/bin/sh\nnpm test\nnpx zedbee scan\n",
          beforeHash: expectHash("#!/bin/sh\nnpm test\n"),
          afterHash: expectHash("#!/bin/sh\nnpm test\nnpx zedbee scan\n"),
          diff: "preview",
          mode: 0o751,
        },
      ],
    };

    const result = await applyInitProposal(proposal);

    expect(result).toEqual({
      applied: true,
      files: [".husky/pre-commit"],
      rolledBack: false,
    });
    expect(await readFile(hookPath, "utf8")).toContain("zedbee scan");
    if (process.platform !== "win32") {
      expect((await lstat(hookPath)).mode & 0o777).toBe(0o751);
    }
  });

  it("rolls back prior writes if a later atomic write fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-init-rollback-"));
    roots.push(root);
    const proposal = proposalFor(root, [
      [".zedbeerc.jsonc", null, "first\n"],
      [".husky/pre-commit", null, "second\n"],
    ]);

    await expect(
      applyInitProposal(proposal, {
        beforeWrite(index) {
          if (index === 1) throw new Error("fixture failure");
        },
      }),
    ).rejects.toThrow("Zedbee initialization failed and was rolled back.");
    await expect(
      readFile(join(root, ".zedbeerc.jsonc"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects symlink targets without modifying their destination", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-init-symlink-"));
    roots.push(root);
    const outside = join(root, "outside.txt");
    await writeFile(outside, "outside\n");
    await symlink(outside, join(root, ".zedbeerc.jsonc"));

    await expect(
      applyInitProposal(
        proposalFor(root, [[".zedbeerc.jsonc", "outside\n", "changed\n"]]),
      ),
    ).rejects.toThrow("Zedbee refused an unsafe initialization target.");
    expect(await readFile(outside, "utf8")).toBe("outside\n");
  });
});

function expectHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function proposalFor(
  repositoryRoot: string,
  files: readonly (readonly [string, string | null, string])[],
): InitProposal {
  return {
    repositoryRoot,
    profile: "recommended",
    hook: "none",
    detectedEnvironments: [],
    recommendedChecks: [],
    vulnerabilityScanningAvailable: false,
    osvUnavailable: "block",
    networkChecks: [],
    limitations: [],
    hookActivation: {
      status: "not-requested",
      message: "No pre-commit integration was requested.",
    },
    files: files.map(([relativePath, before, after]) => ({
      relativePath,
      before,
      after,
      beforeHash: before === null ? null : expectHash(before),
      afterHash: expectHash(after),
      diff: "preview",
      mode: relativePath.includes("pre-commit") ? 0o755 : 0o644,
    })),
  };
}
