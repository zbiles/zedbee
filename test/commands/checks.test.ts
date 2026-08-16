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
  it("returns every check in canonical order with complete machine-readable metadata", async () => {
    const io = terminal();
    const result = await executeChecksCommand(
      { cwd: "/repo", format: "json" },
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
          id: "vulnerabilities",
          executionClass: "network",
          network: "online-package-metadata-only",
          engine: expect.objectContaining({
            name: "OSV-Scanner",
            version: "2.4.0",
            license: "Apache-2.0",
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
      { cwd: "/repo", format: "text" },
      first,
      dependencies,
    );
    await executeChecksCommand(
      { cwd: "/repo", format: "text" },
      second,
      dependencies,
    );
    expect(first.stdout).toEqual(second.stdout);
    expect(first.stdout.join("")).not.toMatch(/\u001B\[[0-9;]*m/u);

    const failed = terminal();
    const result = await executeChecksCommand(
      { cwd: "/repo", format: "json" },
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
