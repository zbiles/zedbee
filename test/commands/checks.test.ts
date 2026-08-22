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
    resolveConfig({
      schemaVersion: 1,
      profile: "thorough",
      checks: {
        formatting: { settings: { printWidth: 100 } },
        lint: { rules: { "no-console": "warn", eqeqeq: "error" } },
      },
      overrides: [
        {
          files: ["test/**"],
          checks: {
            formatting: { settings: { tabWidth: 4 } },
            lint: { rules: { "no-debugger": "error" } },
          },
        },
      ],
    }),
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
    const formatting = result.checks.find(({ id }) => id === "formatting");
    expect(formatting?.configuration).toMatchObject({
      customized: true,
      values: {
        "settings.printWidth": {
          value: 100,
          source: "repository",
          customized: true,
        },
        "settings.tabWidth": {
          value: 2,
          source: "profile",
          customized: false,
        },
      },
      overrides: [
        {
          files: ["test/**"],
          values: {
            "settings.tabWidth": 4,
          },
        },
      ],
    });
    expect(Object.keys(formatting?.configuration.values ?? {})).toEqual([
      "settings.arrowParens",
      "settings.bracketSameLine",
      "settings.bracketSpacing",
      "settings.embeddedLanguageFormatting",
      "settings.endOfLine",
      "settings.jsxSingleQuote",
      "settings.printWidth",
      "settings.proseWrap",
      "settings.quoteProps",
      "settings.semi",
      "settings.singleQuote",
      "settings.tabWidth",
      "settings.trailingComma",
      "settings.useTabs",
    ]);
    const lint = result.checks.find(({ id }) => id === "lint");
    expect(Object.keys(lint?.configuration.values ?? {})).toEqual([
      "rules.eqeqeq",
      "rules.no-console",
    ]);
    expect(lint?.configuration.overrides).toEqual([
      {
        files: ["test/**"],
        values: {
          "rules.no-debugger": "error",
        },
      },
    ]);
    const duplication = result.checks.find(({ id }) => id === "duplication");
    expect(duplication?.configuration).toMatchObject({
      customized: false,
      values: {
        "settings.minLines": {
          value: 5,
          source: "profile",
          customized: false,
        },
        threshold: {
          value: 5,
          source: "profile",
          customized: false,
        },
      },
      overrides: [],
    });
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
    expect(first.stdout.join("")).toContain(
      "Configuration: 13 profile values, 1 repository value",
    );
    expect(first.stdout.join("")).toContain(
      "settings.printWidth: 100 (repository) (customized)",
    );
    expect(first.stdout.join("")).toContain(
      "Override test/**: settings.tabWidth: 4",
    );

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
