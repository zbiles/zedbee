import { describe, expect, it } from "vitest";
import {
  executeChecksCommand,
  type ChecksCommandDependencies,
  type ChecksCommandIO,
} from "../../src/commands/checks.js";
import { CHECK_IDS } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/profiles.js";

function terminal(): ChecksCommandIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    stdoutIsTTY: false,
    width: 80,
    env: {},
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
  };
}

const dependencies: ChecksCommandDependencies = {
  resolveRepositoryRoot: async () => "/repo",
  loadConfig: async () =>
    resolveConfig({ schemaVersion: 1, profile: "thorough" }),
  inspectChecks: async () =>
    new Map(
      CHECK_IDS.map((id) => [
        id,
        {
          applicable: id !== "reactAccessibility",
          targets: id === "types" ? ["packages/api"] : ["."],
          executionClass:
            id === "vulnerabilities" ? "network" : "project-analysis",
        },
      ]),
    ),
};

describe("executeChecksCommand", () => {
  it("renders the Checks dashboard in a wide interactive terminal", async () => {
    const io = {
      ...terminal(),
      stdoutIsTTY: true,
      width: 100,
    };
    const renders: unknown[] = [];

    const result = await executeChecksCommand(
      { cwd: "/repo", format: "auto", color: true },
      io,
      {
        ...dependencies,
        renderDashboard: async (checks, options) => {
          renders.push({ checks, options });
        },
      },
    );

    expect(result.exitCode).toBe(0);
    expect(io.stdout).toEqual([]);
    expect(renders).toEqual([
      {
        checks: result.checks,
        options: { width: 100, color: true },
      },
    ]);
  });

  it.each([
    ["narrow terminal", true, 79, {}],
    ["redirected output", false, 120, {}],
    ["dumb terminal", true, 120, { TERM: "dumb" }],
    ["CI pseudo-terminal", true, 120, { CI: "true" }],
  ] as const)("uses plain text for a %s", async (_name, tty, width, env) => {
    const io = { ...terminal(), stdoutIsTTY: tty, width, env };
    await executeChecksCommand(
      { cwd: "/repo", format: "auto", color: true },
      io,
      dependencies,
    );

    expect(io.stdout.join("")).toContain("formatting [error/relevant]");
    expect(io.stdout.join("")).not.toMatch(/\u001B\[[0-9;]*m/u);
  });

  it("lets explicit text force the plain view and NO_COLOR disable dashboard color", async () => {
    const plain = { ...terminal(), stdoutIsTTY: true, width: 120 };
    await executeChecksCommand(
      { cwd: "/repo", format: "text", color: true },
      plain,
      dependencies,
    );
    expect(plain.stdout.join("")).toContain("formatting [error/relevant]");

    const noColor = {
      ...terminal(),
      stdoutIsTTY: true,
      width: 120,
      env: { NO_COLOR: "1" },
    };
    const renders: unknown[] = [];
    await executeChecksCommand(
      { cwd: "/repo", format: "auto", color: true },
      noColor,
      {
        ...dependencies,
        renderDashboard: async (_checks, options) => {
          renders.push(options);
        },
      },
    );
    expect(renders).toEqual([{ width: 120, color: false }]);
  });

  it("returns every check in canonical order with complete machine-readable metadata", async () => {
    const io = terminal();
    const result = await executeChecksCommand(
      { cwd: "/repo", format: "json", color: true },
      io,
      dependencies,
    );

    expect(result.exitCode).toBe(0);
    expect(result.checks.map(({ id }) => id)).toEqual(CHECK_IDS);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "types",
          description: expect.any(String),
          severity: "error",
          timing: "relevant",
          applicability: "applicable",
          targets: ["packages/api"],
          executionClass: "project-analysis",
          network: "none",
          engine: expect.objectContaining({
            name: "TypeScript",
            version: "6.0.3",
            license: "Apache-2.0",
          }),
          limitation: expect.any(String),
        }),
        expect.objectContaining({
          id: "secrets",
          engine: expect.objectContaining({
            name: "Secretlint",
            version: "13.0.4",
            license: "MIT",
          }),
        }),
        expect.objectContaining({
          id: "reactCorrectness",
          limitation:
            "Calibrates from staged React dependency data and falls back to managed React 19.2 settings.",
        }),
        expect.objectContaining({
          id: "vulnerabilities",
          executionClass: "network",
          network: "online-package-metadata-only",
          engine: expect.objectContaining({
            name: "Zedbee OSV API client",
            version: "v1",
            license: "PolyForm-Small-Business-1.0.0",
          }),
        }),
      ]),
    );
    expect(JSON.parse(io.stdout.join(""))).toEqual(result);
    expect(io.stderr).toEqual([]);
  });

  it("renders deterministic ANSI-free text and fails closed on inspection errors", async () => {
    const first = terminal();
    const second = terminal();
    await executeChecksCommand(
      { cwd: "/repo", format: "text", color: true },
      first,
      dependencies,
    );
    await executeChecksCommand(
      { cwd: "/repo", format: "text", color: true },
      second,
      dependencies,
    );
    expect(first.stdout).toEqual(second.stdout);
    expect(first.stdout.join("")).not.toMatch(/\u001B\[[0-9;]*m/u);

    const failed = terminal();
    const result = await executeChecksCommand(
      { cwd: "/repo", format: "json", color: true },
      failed,
      {
        ...dependencies,
        inspectChecks: async () => {
          throw new Error("/private/tmp/secret");
        },
      },
    );
    expect(result).toEqual({ exitCode: 2, checks: [] });
    expect(failed.stderr).toEqual([
      "Zedbee could not describe the configured checks.\n",
    ]);
    expect(JSON.stringify(failed)).not.toContain("/private/tmp/secret");
  });
});
