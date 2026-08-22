import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  executeInitCommand,
  type InitCommandDependencies,
  type InitCommandIO,
} from "../../src/commands/init.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
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
    deps.confirm = async (proposal, options, proposalForChecks) => {
      const reviewed = proposalForChecks(["lint", "types"], "warn");
      received.push({ proposal, options });
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
    expect(written).toContain('"profile": "recommended"');
    expect(written).toContain('"lint": "error"');
    expect(written).toContain('"formatting": "off"');
  });

  it("reports manager configuration as pending activation without running project tooling", async () => {
    const root = await fixture();
    await writeFile(
      join(root, "lefthook.yml"),
      "pre-commit:\n  commands: {}\n",
    );
    const io = terminal(false);

    const exitCode = await executeInitCommand(
      {
        cwd: root,
        profile: "fast",
        hook: "lefthook",
        yes: true,
        format: "json",
        color: false,
        animations: false,
      },
      io,
      dependencies(root),
    );

    expect(exitCode).toBe(0);
    expect(JSON.parse(io.stdout.join(""))).toMatchObject({
      applied: true,
      proposal: {
        hook: "lefthook",
        hookActivation: {
          status: "pending",
          remediation: expect.stringContaining("lefthook install"),
        },
      },
    });
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
      proposalForChecks,
    ) => proposalForChecks(["lint", "types"], "block");

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
});
