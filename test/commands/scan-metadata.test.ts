import { describe, expect, it } from "vitest";
import { createInitProposal } from "../../src/init/recommend.js";
import { executeScanCommand } from "../../src/commands/scan.js";
import type { TelemetrySummary } from "../../src/telemetry/client.js";
import { createGitRepository } from "../helpers/git-repository.js";

const fastChecks = [
  "formatting",
  "lint",
  "cyclomaticComplexity",
  "readabilityComplexity",
  "structuralSecurity",
  "reactCorrectness",
  "reactAccessibility",
];

async function scan(root: string, baseRef?: string) {
  const summary: TelemetrySummary = {};
  const stdout: string[] = [];
  const exitCode = await executeScanCommand(
    {
      cwd: root,
      format: "json",
      color: false,
      animations: false,
      service: false,
      ...(baseRef === undefined ? {} : { baseRef }),
      telemetrySummary: (value) => Object.assign(summary, value),
    },
    {
      stdinIsTTY: false,
      stdoutIsTTY: false,
      width: 80,
      env: {},
      writeStdout: (value) => stdout.push(value),
      writeStderr() {},
    },
  );
  return { summary, exitCode, report: JSON.parse(stdout.join("")) };
}

describe("scan configuration metadata", () => {
  it("preserves the built-in profile for init-generated default-equivalent settings", async () => {
    const repository = await createGitRepository();
    const proposal = createInitProposal(
      {
        snapshotRoot: repository.root,
        packageManager: "npm",
        lockfiles: ["package-lock.json"],
        workspaces: [
          {
            relativeRoot: ".",
            manifestPath: "package.json",
            sourceFiles: ["app.js"],
            tsconfigPaths: [],
            environments: ["javascript"],
            dependencyDeclarations: [],
          },
        ],
      },
      { repositoryRoot: repository.root, profile: "thorough", hook: "none" },
    );
    const configuration = proposal.files.find(
      (file) => file.relativePath === ".zedbeerc.jsonc",
    );
    expect(configuration).toBeDefined();
    await repository.write(".zedbeerc.jsonc", configuration!.after);
    await repository.commitAll("generated thorough policy");
    const result = await scan(repository.root);
    expect(result.exitCode).toBe(0);
    expect(result.summary.profile).toBe("thorough");
    expect(result.summary.enabled_check_ids).toContain("vulnerabilities");
  });

  it("marks a changed check setting custom even when enabled check IDs are unchanged", async () => {
    const repository = await createGitRepository();
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        profile: "thorough",
        checks: { vulnerabilities: { onUnavailable: "warn" } },
      }),
    );
    await repository.commitAll("custom outage behavior");
    const result = await scan(repository.root);
    expect(result.exitCode).toBe(0);
    expect(result.summary.profile).toBe("custom");
    expect(result.summary.enabled_check_ids).toContain("vulnerabilities");
  });

  it("reports the index profile and enabled checks on empty input despite an unstaged policy edit", async () => {
    const repository = await createGitRepository();
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify({ schemaVersion: 1, profile: "fast" }),
    );
    await repository.commitAll("fast policy");
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify({ schemaVersion: 1, profile: "thorough" }),
    );
    const result = await scan(repository.root);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual({
      profile: "fast",
      enabled_check_ids: fastChecks,
      empty_input: true,
      check_ids: [],
      finding_count: 0,
    });
    expect(result.report.checks).toEqual([]);
  });

  it("reports the target commit policy for base scans despite staged and working tree changes", async () => {
    const repository = await createGitRepository();
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify({ schemaVersion: 1, profile: "fast" }),
    );
    await repository.commitAll("fast policy");
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify({ schemaVersion: 1, profile: "thorough" }),
    );
    await repository.git(["add", ".zedbeerc.jsonc"]);
    const result = await scan(repository.root, "HEAD");
    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual({
      profile: "fast",
      enabled_check_ids: fastChecks,
      empty_input: true,
      check_ids: [],
      finding_count: 0,
    });
  });

  it("retains configured enabled IDs when every check skips the changed input", async () => {
    const repository = await createGitRepository();
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        profile: "fast",
        checks: {
          formatting: "off",
          lint: "off",
          cyclomaticComplexity: "off",
          readabilityComplexity: "off",
          structuralSecurity: "off",
          reactAccessibility: "off",
        },
      }),
    );
    await repository.commitAll("react policy");
    await repository.write("readme.txt", "plain text\n");
    await repository.git(["add", "readme.txt"]);
    const result = await scan(repository.root);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual({
      profile: "custom",
      enabled_check_ids: ["reactCorrectness"],
      empty_input: false,
      check_ids: [],
      finding_count: 0,
    });
    expect(result.report.checks.length).toBeGreaterThan(0);
    expect(
      result.report.checks.every(
        (check: { status: string }) => check.status === "skipped",
      ),
    ).toBe(true);
  });

  it("omits unknown policy metadata when configuration resolution fails", async () => {
    const repository = await createGitRepository();
    await repository.write(".zedbeerc.jsonc", "invalid json");
    await repository.commitAll("invalid policy");
    const result = await scan(repository.root);
    expect(result.exitCode).toBe(2);
    expect(result.summary).not.toHaveProperty("profile");
    expect(result.summary).not.toHaveProperty("enabled_check_ids");
  });

  it("marks customized policies and includes scoped enabled checks even when nothing executes", async () => {
    const repository = await createGitRepository();
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        profile: "fast",
        checks: { formatting: "off" },
        overrides: [{ files: ["private-path/**"], checks: { types: "warn" } }],
      }),
    );
    await repository.commitAll("custom policy");
    const result = await scan(repository.root);
    expect(result.exitCode).toBe(0);
    expect(result.summary).toEqual({
      profile: "custom",
      enabled_check_ids: [
        "lint",
        "types",
        "cyclomaticComplexity",
        "readabilityComplexity",
        "structuralSecurity",
        "reactCorrectness",
        "reactAccessibility",
      ],
      empty_input: true,
      check_ids: [],
      finding_count: 0,
    });
    expect(JSON.stringify(result.summary)).not.toContain("private-path");
  });
});
