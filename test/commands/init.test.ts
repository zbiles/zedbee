import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeInitCommand,
  type InitCommandDependencies,
  type InitCommandIO,
} from "../../src/commands/init.js";
import { applyInitProposal } from "../../src/init/write-config.js";
import { initFileChange } from "../../src/init/recommend.js";
import type { InitProposal } from "../../src/init/types.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { createGitRepository } from "../helpers/git-repository.js";

function packageRoot(): string {
  return fileURLToPath(new URL("../..", import.meta.url));
}

const roots: string[] = [];
afterEach(async () => {
  await Promise.allSettled(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

function terminal(
  tty = false,
): InitCommandIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdinIsTTY: tty,
    stdoutIsTTY: tty,
    width: 80,
    env: {},
    stdout,
    stderr,
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
  };
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zedbee-init-command-"));
  roots.push(root);
  await writeFile(
    join(root, "package.json"),
    `${JSON.stringify({ name: "fixture", dependencies: { typescript: "6.0.0" } })}\n`,
  );
  await writeFile(join(root, "index.ts"), "export const value: number = 1;\n");
  return root;
}

function dependencies(root: string): InitCommandDependencies {
  return {
    resolveRepositoryRoot: async () => root,
    inspect: inspectRepository,
    confirm: async () => false,
  };
}

describe("executeInitCommand", () => {
  it.each([
    ["auto", "raw"],
    ["tracked", "husky"],
    ["none", "none"],
  ] as const)(
    "applies --hook %s --yes without questions",
    async (hook, resolved) => {
      const repository = await createGitRepository(
        "zedbee-init-noninteractive-",
      );
      await repository.write("package.json", '{"name":"fixture"}');
      const deps = dependencies(repository.root);
      deps.confirm = async () => {
        throw new Error("must not prompt");
      };
      const io = terminal(true);
      expect(
        await executeInitCommand(
          {
            cwd: repository.root,
            profile: "recommended",
            hook,
            yes: true,
            format: "json",
            color: false,
            animations: false,
          },
          io,
          deps,
        ),
      ).toBe(0);
      const output = JSON.parse(io.stdout.join(""));
      expect(output.applied).toBe(true);
      expect(output.proposal.hook).toBe(resolved);
    },
  );
  it("offers new tracked/local alternatives interactively and honors choosing no hook", async () => {
    const repository = await createGitRepository("zedbee-init-choices-");
    await repository.write("package.json", '{"name":"fixture"}');
    const io = terminal(true);
    const deps = dependencies(repository.root);
    deps.confirm = async (proposal, _options, select) => {
      expect(proposal.hookSelection).toBe("tracked");
      expect(proposal.hookChoices).toEqual(["none", "tracked", "raw"]);
      const local = select("recommended", undefined, "block", "raw");
      expect(
        local.files.some(
          (file) => file.relativePath === ".git/hooks/pre-commit",
        ),
      ).toBe(true);
      return select("recommended", undefined, "block", "none");
    };
    const code = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "auto",
        yes: false,
        format: "text",
        color: false,
        animations: false,
      },
      io,
      deps,
    );
    expect(code).toBe(0);
    expect(
      (await repository.git(["config", "--get", "core.hooksPath"])).exitCode,
    ).toBe(1);
    await expect(repository.read(".git/hooks/pre-commit")).rejects.toThrow();
    expect(await repository.read(".zedbeerc.jsonc")).toContain("recommended");
  });

  it("reuses an existing manager without offering tracked/local alternatives", async () => {
    const repository = await createGitRepository("zedbee-init-existing-");
    await repository.write("package.json", '{"name":"fixture"}');
    await repository.write(
      "lefthook.yml",
      "pre-commit:\n  commands:\n    test:\n      run: npm test\n",
    );
    const io = terminal(true);
    const deps = dependencies(repository.root);
    deps.confirm = async (proposal) => {
      expect(proposal.hookChoices).toEqual(["none", "lefthook"]);
      return proposal;
    };
    expect(
      await executeInitCommand(
        {
          cwd: repository.root,
          profile: "recommended",
          hook: "auto",
          yes: false,
          format: "text",
          color: false,
          animations: false,
        },
        io,
        deps,
      ),
    ).toBe(0);
    expect(await repository.read("lefthook.yml")).toContain("npm test");
  });

  it("keeps Local and No available when tracked setup has no root manifest", async () => {
    const repository = await createGitRepository("zedbee-init-local-fallback-");
    const deps = dependencies(repository.root);
    deps.confirm = async (proposal, _options, select) => {
      expect(proposal.hookChoices).toEqual(["none", "raw"]);
      expect(proposal.limitations.join(" ")).toContain(
        "Tracked setup is unavailable",
      );
      return select("recommended", undefined, "block", "raw");
    };
    expect(
      await executeInitCommand(
        {
          cwd: repository.root,
          profile: "recommended",
          hook: "auto",
          yes: false,
          format: "text",
          color: false,
          animations: false,
        },
        terminal(true),
        deps,
      ),
    ).toBe(0);
    expect(await repository.read(".git/hooks/pre-commit")).toContain(
      "zedbee scan",
    );
  });
  it("explains a known unsafe repository-inspection failure without exposing paths", async () => {
    const root = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "zedbee-init-outside-"));
    roots.push(outside);
    const outsideFile = join(outside, "outside.ts");
    await writeFile(outsideFile, "private path details must not escape\n");
    await symlink(outsideFile, join(root, "escape.ts"));
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: root,
        profile: "recommended",
        hook: "none",
        yes: false,
        format: "text",
        color: false,
        animations: false,
      },
      io,
      dependencies(root),
    );

    expect(exitCode).toBe(2);
    expect(io.stderr.join("")).toBe(
      [
        "Zedbee could not initialize this repository safely.",
        "Reason: Repository inspection found a symbolic link that leaves the repository.",
        "Remediation: Remove the external link or move it into a directory Zedbee ignores.",
        "",
      ].join("\n"),
    );
    expect(io.stderr.join("")).not.toContain(root);
    expect(io.stderr.join("")).not.toContain("private path details");
  });

  it("does not expose details from an unknown initialization failure", async () => {
    const root = await fixture();
    const io = terminal(false);
    const deps = dependencies(root);
    deps.inspect = async () => {
      throw new Error("private unknown failure details");
    };

    const exitCode = await executeInitCommand(
      {
        cwd: root,
        profile: "recommended",
        hook: "none",
        yes: false,
        format: "text",
        color: false,
        animations: false,
      },
      io,
      deps,
    );

    expect(exitCode).toBe(2);
    expect(io.stderr.join("")).toBe(
      "Zedbee could not initialize this repository safely.\n",
    );
    expect(io.stderr.join("")).not.toContain("private unknown failure");
  });

  it("prints a deterministic JSON proposal without writing when confirmation is absent", async () => {
    const root = await fixture();
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: root,
        profile: "recommended",
        hook: "none",
        yes: false,
        format: "json",
        color: false,
        animations: false,
      },
      io,
      dependencies(root),
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout.join(""))).toMatchObject({
      applied: false,
      proposal: {
        profile: "recommended",
        hook: "none",
        recommendedChecks: expect.arrayContaining(["types"]),
      },
    });
    await expect(
      readFile(join(root, ".zedbeerc.jsonc"), "utf8"),
    ).rejects.toThrow();
  });

  it("applies the exact proposal with --yes and reports only repository-relative paths", async () => {
    const root = await fixture();
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: root,
        profile: "fast",
        hook: "none",
        yes: true,
        format: "json",
        color: true,
        animations: true,
      },
      io,
      dependencies(root),
    );

    expect(exitCode).toBe(0);
    expect(await readFile(join(root, ".zedbeerc.jsonc"), "utf8")).toContain(
      '"profile": "fast"',
    );
    expect(await readFile(join(root, ".zedbeerc.jsonc"), "utf8")).toContain(
      '"agentGuidance"',
    );
    const output = io.stdout.join("");
    expect(output).not.toContain(root);
    expect(JSON.parse(output)).toMatchObject({
      applied: true,
      files: [".zedbeerc.jsonc"],
    });
  });

  it("uses the same proposal in interactive mode and honors NO_COLOR/no animations", async () => {
    const root = await fixture();
    const io = terminal(true);
    io.env.NO_COLOR = "1";
    const received: unknown[] = [];
    const deps = dependencies(root);
    deps.confirm = async (proposal, options, proposalForSelection) => {
      expect(options).not.toHaveProperty("terminalSize");
      const reviewed = proposalForSelection(
        "thorough",
        ["lint", "types"],
        "warn",
      );
      received.push({ proposal, options });
      expect(reviewed.profile).toBe("thorough");
      expect(reviewed.recommendedChecks).toEqual(["lint", "types"]);
      expect(reviewed.osvUnavailable).toBe("warn");
      expect(reviewed.files[0]?.diff).toContain('"formatting": "off"');
      return reviewed;
    };

    const exitCode = await executeInitCommand(
      {
        cwd: root,
        profile: "recommended",
        hook: "none",
        yes: false,
        format: "text",
        color: true,
        animations: false,
      },
      io,
      deps,
    );

    expect(exitCode).toBe(0);
    expect(received).toEqual([
      expect.objectContaining({
        options: { color: false, animations: false, width: 80 },
      }),
    ]);
    const written = await readFile(join(root, ".zedbeerc.jsonc"), "utf8");
    expect(written).toContain('"profile": "thorough"');
    expect(written).toContain('"lint": "error"');
    expect(written).toContain('"formatting": "off"');
    expect(io.stdout.join("")).toBe("Zedbee initialized successfully\n");
  });

  it("reports a concise cancellation after an interactive decision", async () => {
    const root = await fixture();
    const io = terminal(true);
    const deps = dependencies(root);
    deps.confirm = async () => false;

    const exitCode = await executeInitCommand(
      {
        cwd: root,
        profile: "recommended",
        hook: "none",
        yes: false,
        format: "text",
        color: false,
        animations: false,
      },
      io,
      deps,
    );

    expect(exitCode).toBe(0);
    expect(io.stdout.join("")).toBe("Zedbee initialization cancelled\n");
    await expect(
      readFile(join(root, ".zedbeerc.jsonc"), "utf8"),
    ).rejects.toThrow();
  });

  it("reports manager configuration as pending activation without running project tooling", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "lefthook.yml"),
      "pre-commit:\n  commands: {}\n",
    );
    const io = terminal(true);
    const deps = dependencies(root);
    deps.confirm = async (proposal) => proposal;

    const exitCode = await executeInitCommand(
      {
        cwd: root,
        profile: "fast",
        hook: "lefthook",
        yes: false,
        format: "text",
        color: false,
        animations: false,
      },
      io,
      deps,
    );

    expect(exitCode).toBe(0);
    expect(io.stdout.join("")).toBe(
      [
        "Zedbee initialized successfully",
        "Next step: After reviewing the project tooling, run lefthook install to activate the configured hook.",
        "",
      ].join("\n"),
    );
  });

  it("writes the non-interactive OSV outage choice and disclosure", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "package-lock.json"),
      `${JSON.stringify({ lockfileVersion: 3, packages: {} })}\n`,
    );
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: root,
        profile: "thorough",
        hook: "none",
        osvUnavailable: "warn",
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      io,
      dependencies(root),
    );

    expect(exitCode).toBe(0);
    expect(await readFile(join(root, ".zedbeerc.jsonc"), "utf8")).toContain(
      '"onUnavailable": "warn"',
    );
    expect(JSON.parse(io.stdout.join(""))).toMatchObject({
      proposal: {
        osvUnavailable: "warn",
        networkChecks: [
          {
            id: "vulnerabilities",
            onUnavailable: "warn",
          },
        ],
      },
    });
  });

  it("makes an interactive selection byte-equivalent to non-interactive --checks", async () => {
    const interactiveRoot = await fixture();
    const nonInteractiveRoot = await fixture();
    const interactive = terminal(true);
    const nonInteractive = terminal(false);
    const interactiveDependencies = dependencies(interactiveRoot);
    interactiveDependencies.confirm = async (
      _proposal,
      _options,
      proposalForSelection,
    ) => proposalForSelection("recommended", ["lint", "types"], "block");

    const baseOptions = {
      profile: "recommended" as const,
      hook: "none" as const,
      format: "text" as const,
      color: false,
      animations: false,
    };
    await executeInitCommand(
      {
        ...baseOptions,
        cwd: interactiveRoot,
        yes: false,
      },
      interactive,
      interactiveDependencies,
    );
    await executeInitCommand(
      {
        ...baseOptions,
        cwd: nonInteractiveRoot,
        checks: ["lint", "types"],
        yes: true,
      },
      nonInteractive,
      dependencies(nonInteractiveRoot),
    );

    expect(
      await readFile(join(interactiveRoot, ".zedbeerc.jsonc"), "utf8"),
    ).toBe(await readFile(join(nonInteractiveRoot, ".zedbeerc.jsonc"), "utf8"));
  });

  it("refuses non-interactive project formatting without explicit trust", async () => {
    const repository = await createGitRepository("zedbee-init-project-trust-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write(".prettierrc.json", '{"singleQuote":true}');
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "project",
        yes: true,
        format: "text",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(exitCode).toBe(2);
    expect(io.stderr.join("")).toMatch(/trust/u);
    await expect(
      readFile(join(repository.root, ".zedbeerc.jsonc"), "utf8"),
    ).rejects.toThrow();
  });

  it("does not treat a tracked trust field as consent", async () => {
    const repository = await createGitRepository("zedbee-init-tracked-trust-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write(
      ".zedbeerc.jsonc",
      '{\n  "schemaVersion": 1,\n  "projectPrettierTrust": true\n}\n',
    );
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "project",
        yes: true,
        format: "text",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(exitCode).toBe(2);
    expect(io.stderr.join("")).toMatch(/trust/u);
  });

  it("applies project formatting and persists local consent with --trust-project-prettier", async () => {
    const repository = await createGitRepository("zedbee-init-project-apply-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write(".prettierrc.json", '{"singleQuote":true}');
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "project",
        trustProjectPrettier: true,
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(exitCode).toBe(0);
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(config).toContain('"engine": "project"');
    expect(config).not.toMatch(/trustProjectPrettier/u);
    const stored = await repository.git([
      "config",
      "--local",
      "--get-regexp",
      "allowed",
    ]);
    expect(stored.stdout).toContain("v1");
  });

  it("copies detected settings non-interactively", async () => {
    const repository = await createGitRepository("zedbee-init-copy-");
    await repository.write("package.json", '{"name":"fixture"}');
    await repository.write(
      ".prettierrc.json",
      '{"printWidth":100,"trailingComma":"es5"}',
    );
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "copy",
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(exitCode).toBe(0);
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(config).toContain('"printWidth": 100');
    expect(config).toContain('"trailingComma": "es5"');
  });

  it("preserves formatting timing when copying detected settings", async () => {
    const repository = await createGitRepository("zedbee-init-copy-timing-");
    await repository.write("package.json", '{"name":"fixture"}');
    await repository.write(".prettierrc.json", '{"singleQuote":true}');
    await repository.write(
      ".zedbeerc.jsonc",
      '{"schemaVersion":1,"checks":{"formatting":{"severity":"warn","when":"always"}}}',
    );
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "copy",
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(exitCode).toBe(0);
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(config).toContain('"when": "always"');
  });

  it("refuses a non-interactive copy with unresolved limitations", async () => {
    const repository = await createGitRepository("zedbee-init-copy-limits-");
    await repository.write("package.json", '{"name":"fixture"}');
    await repository.write(
      ".prettierrc.json",
      '{"printWidth":100,"plugins":["some-plugin"]}',
    );
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "copy",
        yes: true,
        format: "text",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(exitCode).toBe(2);
    await expect(
      readFile(join(repository.root, ".zedbeerc.jsonc"), "utf8"),
    ).rejects.toThrow();
  });

  it("preserves an existing explicit project choice on repeat init", async () => {
    const repository = await createGitRepository("zedbee-init-repeat-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write(".prettierrc.json", '{"singleQuote":true}');
    const first = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "project",
        trustProjectPrettier: true,
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      terminal(false),
      dependencies(repository.root),
    );
    expect(first).toBe(0);

    const io = terminal(false);
    const second = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(second).toBe(0);
    expect(JSON.parse(io.stdout.join(""))).toMatchObject({
      proposal: {
        formatting: "project",
        formattingDetection: [
          expect.objectContaining({
            projectRoot: ".",
            status: "missing",
            configPaths: [".prettierrc.json"],
          }),
        ],
      },
    });
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(config).toContain('"engine": "project"');
  });

  it("revokes local consent when init switches the project to managed", async () => {
    const repository = await createGitRepository("zedbee-init-revoke-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write(".prettierrc.json", '{"singleQuote":true}');
    await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "project",
        trustProjectPrettier: true,
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      terminal(false),
      dependencies(repository.root),
    );
    const granted = await repository.git([
      "config",
      "--local",
      "--get-regexp",
      "allowed",
    ]);
    expect(granted.stdout).toContain("v1");

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "managed",
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      terminal(false),
      dependencies(repository.root),
    );

    expect(exitCode).toBe(0);
    const revoked = await repository.git([
      "config",
      "--local",
      "--get-regexp",
      "allowed",
    ]);
    expect(revoked.exitCode).toBe(1);
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(config).toContain('"engine": "managed"');
  });

  it("replaces imported overrides on repeat copies instead of duplicating them", async () => {
    const repository = await createGitRepository("zedbee-init-copy-repeat-");
    await repository.write("package.json", '{"name":"fixture"}');
    await repository.write(
      ".prettierrc.json",
      '{"printWidth":100,"overrides":[{"files":"*.md","options":{"printWidth":80}}]}',
    );
    const baseOptions = {
      cwd: repository.root,
      profile: "recommended" as const,
      hook: "none" as const,
      formatting: "copy" as const,
      yes: true,
      format: "json" as const,
      color: false,
      animations: false,
    };
    await executeInitCommand(
      baseOptions,
      terminal(false),
      dependencies(repository.root),
    );
    const first = await readFile(join(repository.root, ".zedbeerc.jsonc"), "utf8");

    await executeInitCommand(
      baseOptions,
      terminal(false),
      dependencies(repository.root),
    );
    const second = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );

    expect(second).toBe(first);
    expect(second.match(/packages\/web\*\*/gu)?.length ?? 0).toBe(0);
    expect(second).toContain('"**/*.md"');
  });

  it("reports a detected setup on default non-interactive init without importing it", async () => {
    const repository = await createGitRepository("zedbee-init-detect-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write(".prettierrc.json", '{"singleQuote":true}');
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout.join(""))).toMatchObject({
      proposal: {
        formatting: "managed",
        formattingDetection: [
          {
            projectRoot: ".",
            status: "missing",
            executableConfig: false,
            configPaths: [".prettierrc.json"],
          },
        ],
      },
    });
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(config).not.toContain("singleQuote");
  });

  it("evaluates a consented executable configuration against the previewed working copy", async () => {
    const repository = await createGitRepository("zedbee-init-copy-exec-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.git(["add", "--", "package.json"]);
    await mkdir(join(repository.root, "node_modules"), { recursive: true });
    await cp(
      join(packageRoot(), "node_modules", "prettier"),
      join(repository.root, "node_modules", "prettier"),
      { recursive: true },
    );
    // The executable config is untracked: a Git-index snapshot would not
    // contain it, but setup evaluates exactly the previewed working copy.
    await repository.write(
      "prettier.config.mjs",
      "export default { singleQuote: true, printWidth: 120 };\n",
    );
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "copy",
        trustProjectPrettier: true,
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(exitCode, io.stderr.join("")).toBe(0);
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(config).toContain('"printWidth": 120');
    expect(config).toContain('"singleQuote": true');
  });

  it("keeps the executable configuration as a copy limitation without consent", async () => {
    const repository = await createGitRepository("zedbee-init-copy-exec-no-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write(
      "prettier.config.mjs",
      "export default { singleQuote: true };\n",
    );
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "copy",
        yes: true,
        format: "text",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(exitCode).toBe(2);
    await expect(
      readFile(join(repository.root, ".zedbeerc.jsonc"), "utf8"),
    ).rejects.toThrow();
  });

  it("evaluates a package-exported shared configuration through the installed dependency", async () => {
    const repository = await createGitRepository("zedbee-init-shared-eval-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0","@org/prettier-config":"^1.0.0"},"prettier":"@org/prettier-config"}',
    );
    await repository.git(["add", "--", "package.json"]);
    await mkdir(join(repository.root, "node_modules", "@org", "prettier-config"), {
      recursive: true,
    });
    await writeFile(
      join(repository.root, "node_modules", "@org", "prettier-config", "package.json"),
      '{"name":"@org/prettier-config","version":"1.0.0","type":"module","main":"index.mjs"}',
    );
    await writeFile(
      join(repository.root, "node_modules", "@org", "prettier-config", "index.mjs"),
      "export default { printWidth: 120, semi: false };\n",
    );
    await cp(
      join(packageRoot(), "node_modules", "prettier"),
      join(repository.root, "node_modules", "prettier"),
      { recursive: true },
    );
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "copy",
        trustProjectPrettier: true,
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(exitCode, io.stderr.join("")).toBe(0);
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(config).toContain('"printWidth": 120');
    expect(config).toContain('"semi": false');
  });

  it("refuses an apply whose evaluated configuration changed after the preview", async () => {
    const repository = await createGitRepository("zedbee-init-stale-eval-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.git(["add", "--", "package.json"]);
    await mkdir(join(repository.root, "node_modules"), { recursive: true });
    await cp(
      join(packageRoot(), "node_modules", "prettier"),
      join(repository.root, "node_modules", "prettier"),
      { recursive: true },
    );
    await repository.write(
      "prettier.config.mjs",
      "export default { printWidth: 100 };\n",
    );
    // First run evaluates and binds the working-copy bytes.
    const evaluate = {
      cwd: repository.root,
      profile: "recommended" as const,
      hook: "none" as const,
      formatting: "copy" as const,
      trustProjectPrettier: true,
      yes: true,
      format: "json" as const,
      color: false,
      animations: false,
    };
    await executeInitCommand(
      evaluate,
      terminal(false),
      dependencies(repository.root),
    );
    const first = await readFile(join(repository.root, ".zedbeerc.jsonc"), "utf8");
    expect(first).toContain('"printWidth": 100');

    // Change the evaluated configuration; a second copy run re-evaluates the
    // new working-copy bytes. The newly present plugin limitation blocks the
    // non-interactive copy instead of silently reusing the previously bound
    // import, and the previously written configuration is left untouched.
    await repository.write(
      "prettier.config.mjs",
      "export default { printWidth: 100, plugins: ['p'] };\n",
    );
    const io = terminal(false);
    const second = await executeInitCommand(
      evaluate,
      io,
      dependencies(repository.root),
    );
    expect(second).toBe(2);
    expect(io.stderr.join("")).toMatch(/unresolved limitations/u);
    const config = await readFile(join(repository.root, ".zedbeerc.jsonc"), "utf8");
    expect(config).toBe(first);
  });

  it("refuses an apply whose evaluated configuration bytes changed after the preview", async () => {
    const repository = await createGitRepository("zedbee-init-stale-bytes-");
    await repository.write("prettier.config.mjs", "export default {};\n");
    const original = await readFile(
      join(repository.root, "prettier.config.mjs"),
      "utf8",
    );
    const sha256 = (value: string): string =>
      createHash("sha256").update(value, "utf8").digest("hex");
    const after = "{\"schemaVersion\":1,\"profile\":\"fast\"}\n";
    const proposal: InitProposal = {
      repositoryRoot: repository.root,
      profile: "fast",
      hook: "none",
      hookActivation: {
        status: "not-requested",
        message: "No pre-commit integration was requested.",
      },
      detectedEnvironments: [],
      recommendedChecks: [],
      vulnerabilityScanningAvailable: false,
      osvUnavailable: "block",
      networkChecks: [],
      limitations: [],
      formatting: "copy",
      executableEvaluatedConfig: {
        path: "prettier.config.mjs",
        sha256: sha256(original),
      },
      files: [
        initFileChange(".zedbeerc.jsonc", null, after, 0o644),
      ],
    };

    // The evaluated file changes after the preview; apply must refuse and
    // write nothing.
    await repository.write("prettier.config.mjs", "export default { changed: true };\n");
    await expect(applyInitProposal(proposal)).rejects.toThrow(
      /changed after the preview/u,
    );
    await expect(
      readFile(join(repository.root, ".zedbeerc.jsonc"), "utf8"),
    ).rejects.toThrow();
  });

  it("preserves hand-authored overrides while replacing generated entries", async () => {
    const repository = await createGitRepository("zedbee-init-ownership-");
    await repository.write("package.json", '{"name":"fixture"}');
    await repository.write(
      ".prettierrc.json",
      '{"printWidth":100,"trailingComma":"es5","overrides":[{"files":"*.md","options":{"printWidth":80}}]}',
    );
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify(
        {
          schemaVersion: 1,
          profile: "recommended",
          overrides: [
            {
              files: ["src/**"],
              checks: { formatting: { settings: { printWidth: 90 } } },
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "copy",
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(exitCode, io.stderr.join("")).toBe(0);
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(config).toContain('"src/**"');
    expect(config.match(/"src\/\*\*"/gu)).toHaveLength(1);
    expect(config).toContain('"generated": "prettier-copy"');
    expect(config).toContain('"**/*.md"');
  });

  it("restores Zedbee defaults by removing copied settings and generated overrides only", async () => {
    const repository = await createGitRepository("zedbee-init-managed-reset-");
    await repository.write("package.json", '{"name":"fixture"}');
    await repository.write(
      ".prettierrc.json",
      '{"printWidth":100,"trailingComma":"es5"}',
    );
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify(
        {
          schemaVersion: 1,
          profile: "recommended",
          overrides: [
            {
              files: ["src/**"],
              checks: { formatting: { settings: { printWidth: 90 } } },
            },
          ],
        },
        null,
        2,
      ) + "\n",
    );
    const copy = {
      cwd: repository.root,
      profile: "recommended" as const,
      hook: "none" as const,
      yes: true,
      format: "json" as const,
      color: false,
      animations: false,
    };
    await executeInitCommand(
      { ...copy, formatting: "copy" as const },
      terminal(false),
      dependencies(repository.root),
    );
    const copied = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(copied).toContain('"trailingComma": "es5"');

    const exitCode = await executeInitCommand(
      { ...copy, formatting: "managed" as const },
      terminal(false),
      dependencies(repository.root),
    );

    expect(exitCode).toBe(0);
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(config).toContain('"engine": "managed"');
    // Copied settings are gone; the hand-authored override survives untouched.
    expect(config).not.toContain('"trailingComma"');
    expect(config).toContain('"src/**"');
    expect(config).not.toContain('"generated"');
  });

  it("preserves an explicit formatting-off choice on repeat init", async () => {
    const repository = await createGitRepository("zedbee-init-repeat-off-");
    await repository.write("package.json", '{"name":"fixture"}');
    const first = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "off",
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      terminal(false),
      dependencies(repository.root),
    );
    expect(first).toBe(0);

    const io = terminal(false);
    const second = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(second).toBe(0);
    expect(JSON.parse(io.stdout.join(""))).toMatchObject({
      proposal: { formatting: "off" },
    });
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(config).toContain('"formatting": "off"');
  });

  it("enables and trusts every discovered project with file-scoped engine overrides", async () => {
    const repository = await createGitRepository("zedbee-init-multiproject-");
    await repository.write(
      "package.json",
      '{"name":"root","private":true,"workspaces":["web","app"]}',
    );
    await repository.write(
      "web/package.json",
      '{"name":"web","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write("web/.prettierrc.json", '{"singleQuote":true}');
    await repository.write(
      "app/package.json",
      '{"name":"app","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write("app/.prettierrc.json", '{"printWidth":100}');
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "project",
        trustProjectPrettier: true,
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(exitCode, io.stderr.join("")).toBe(0);
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    // Only the root keeps managed defaults; each project gets a scoped engine.
    expect(config).toContain('"engine": "managed"');
    expect(config).toContain('"web/**"');
    expect(config).toContain('"app/**"');
    expect(config).toContain('"generated": "prettier-engine"');
    const grants = await repository.git([
      "config",
      "--local",
      "--get-regexp",
      "allowed",
    ]);
    expect(grants.stdout.match(/v1/gu)).toHaveLength(2);
  });

  it("revokes every project grant and removes engine overrides on managed", async () => {
    const repository = await createGitRepository("zedbee-init-multi-revoke-");
    await repository.write(
      "package.json",
      '{"name":"root","private":true,"workspaces":["web","app"]}',
    );
    await repository.write(
      "web/package.json",
      '{"name":"web","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write("web/.prettierrc.json", '{"singleQuote":true}');
    await repository.write(
      "app/package.json",
      '{"name":"app","devDependencies":{"prettier":"^3.0.0"}}',
    );
    await repository.write("app/.prettierrc.json", '{"printWidth":100}');
    const base = {
      cwd: repository.root,
      profile: "recommended" as const,
      hook: "none" as const,
      yes: true,
      format: "json" as const,
      color: false,
      animations: false,
    };
    await executeInitCommand(
      { ...base, formatting: "project" as const, trustProjectPrettier: true },
      terminal(false),
      dependencies(repository.root),
    );

    const exitCode = await executeInitCommand(
      { ...base, formatting: "managed" as const },
      terminal(false),
      dependencies(repository.root),
    );

    expect(exitCode).toBe(0);
    const revoked = await repository.git([
      "config",
      "--local",
      "--get-regexp",
      "allowed",
    ]);
    expect(revoked.exitCode).toBe(1);
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(config).toContain('"overrides": []');
    expect(config).not.toContain("prettier-engine");
  });

  it("reports a shared-config specifier in detection without evaluating it", async () => {
    const repository = await createGitRepository("zedbee-init-shared-");
    await repository.write(
      "package.json",
      '{"name":"fixture","devDependencies":{"prettier":"^3.0.0"},"prettier":"@org/prettier-config"}',
    );
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      io,
      dependencies(repository.root),
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout.join(""))).toMatchObject({
      proposal: {
        formattingDetection: [
          {
            projectRoot: ".",
            executableConfig: true,
            sharedConfig: "@org/prettier-config",
          },
        ],
      },
    });
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(config).not.toContain("printWidth");
  });

  it("reports excludeFiles as a copy limitation instead of negating patterns", async () => {
    const repository = await createGitRepository("zedbee-init-copy-exclude-");
    await repository.write("package.json", '{"name":"fixture"}');
    await repository.write(
      ".prettierrc.json",
      '{"printWidth":100,"overrides":[{"files":"*.md","excludeFiles":"*.draft.md","options":{"printWidth":80}}]}',
    );
    const io = terminal(true);
    const deps = dependencies(repository.root);
    deps.confirm = async (proposal) => {
      expect(
        proposal.formattingImport?.limitations.join("\n"),
      ).toMatch(/excludeFiles/u);
      return proposal;
    };

    const exitCode = await executeInitCommand(
      {
        cwd: repository.root,
        profile: "recommended",
        hook: "none",
        formatting: "copy",
        yes: false,
        format: "text",
        color: false,
        animations: false,
      },
      io,
      deps,
    );

    expect(exitCode).toBe(0);
    const config = await readFile(
      join(repository.root, ".zedbeerc.jsonc"),
      "utf8",
    );
    expect(config).toContain('"**/*.md"');
    expect(config).not.toContain("!*.draft.md");
  });
});
