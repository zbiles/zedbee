import { describe, expect, it, onTestFinished } from "vitest";
import {
  executeChecksCommand,
  type ChecksCommandDependencies,
  type ChecksCommandIO,
} from "../../src/commands/checks.js";
import { CHECK_IDS, type ResolvedConfig } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { createGitRepository } from "../helpers/git-repository.js";
import { GitClient } from "../../src/git/client.js";
import { readStagedChangeSet } from "../../src/git/change-set.js";
import { buildSnapshotPair } from "../../src/git/snapshot.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { loadConfig } from "../../src/config/load-config.js";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import { lintAdapter } from "../../src/checks/eslint/lint-adapter.js";

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

function configuredDependencies(
  config: ResolvedConfig,
): ChecksCommandDependencies {
  return {
    ...dependencies,
    loadConfig: async () => config,
    inspectChecks: async () =>
      new Map(
        CHECK_IDS.map((id) => [
          id,
          {
            applicable: true,
            targets: ["."],
            executionClass: "project-analysis",
          },
        ]),
      ),
  };
}

function configWithOverrides(
  overrides: ResolvedConfig["overrides"],
): ResolvedConfig {
  const base = resolveConfig({ schemaVersion: 1, profile: "thorough" });
  return {
    ...base,
    overrides,
  };
}

function configWithMutableLintRule(
  repositoryRule: unknown[],
  overrideRule: unknown[],
): ResolvedConfig {
  const base = resolveConfig({ schemaVersion: 1, profile: "thorough" });
  return {
    ...base,
    checks: {
      ...base.checks,
      lint: {
        ...base.checks.lint,
        rules: { "no-restricted-syntax": repositoryRule },
      },
    },
    overrides: [
      {
        files: ["test/**"],
        checks: {
          lint: {
            rules: { "no-alert": overrideRule },
          },
        },
        configurationOrigins: base.configurationOrigins,
      },
    ],
    configurationOrigins: {
      ...base.configurationOrigins,
      lint: {
        "rules.no-restricted-syntax": { kind: "repository" },
      },
    },
  } as unknown as ResolvedConfig;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

describe("executeChecksCommand", () => {
  it("agrees with dispatch for a matching always override without staged files", async () => {
    const repository = await createGitRepository();
    await repository.write("package.json", '{"name":"fixture"}\n');
    await repository.write("src/enabled.js", "export const enabled = true;\n");
    await repository.write(
      ".zedbeerc.jsonc",
      `${JSON.stringify({
        schemaVersion: 1,
        profile: "recommended",
        checks: { lint: "off" },
        overrides: [
          {
            files: ["src/enabled.js"],
            checks: { lint: { severity: "error", when: "always" } },
          },
        ],
      })}\n`,
    );
    await repository.commitAll("fixture");

    const io = terminal();
    const described = await executeChecksCommand(
      { cwd: repository.root, format: "json", color: false },
      io,
    );

    const git = new GitClient(repository.root);
    const changeSet = await readStagedChangeSet(git);
    const snapshots = await buildSnapshotPair(repository.root, git);
    onTestFinished(snapshots.cleanup);
    const [baselineInspection, targetInspection, config] = await Promise.all([
      inspectRepository(snapshots.baselineDir),
      inspectRepository(snapshots.targetDir),
      loadConfig(repository.root),
    ]);
    let dispatchedRuns = 0;
    const executions = await dispatchChecks(
      [
        {
          ...lintAdapter,
          collect: async (context) => {
            dispatchedRuns += 1;
            return {
              checkId: "lint",
              target: context.target,
              baselineObservations: [],
              targetObservations: [],
            };
          },
        },
      ],
      {
        repositoryRoot: repository.root,
        changeSet,
        config,
        snapshots,
        baselineInspection,
        targetInspection,
        signal: new AbortController().signal,
      },
    );
    const lint = described.checks.find(({ id }) => id === "lint");
    const dispatched = dispatchedRuns === 1 && executions.length === 1;

    expect(dispatched).toBe(true);
    expect(lint?.applicability).toBe(
      dispatched ? "applicable" : "not-applicable",
    );
    expect(lint?.targets).toEqual(["."]);
    expect(io.stdout.join("")).not.toMatch(/\u001B\[[0-9;]*m/u);
  });

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
      "settings.endOfLine",
      "settings.jsxSingleQuote",
      "settings.printWidth",
      "settings.proseWrap",
      "settings.quoteProps",
      "settings.semi",
      "settings.singleAttributePerLine",
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

  it("keeps exact override patterns in JSON but escapes and bounds terminal previews", async () => {
    const hostilePatterns = [
      "src/\u001b[31mred/**",
      "docs/line\nbreak/**",
      "ui/\u202ereversed/**",
      `long/${"segment-".repeat(80)}/**`,
      "extra/a/**",
      "extra/b/**",
      "extra/c/**",
    ];
    const config = configWithOverrides([
      {
        files: hostilePatterns,
        checks: { formatting: { settings: { tabWidth: 4 } } },
        configurationOrigins: resolveConfig({
          schemaVersion: 1,
          profile: "thorough",
        }).configurationOrigins,
      },
    ]);

    const json = terminal();
    const jsonResult = await executeChecksCommand(
      { cwd: "/repo", format: "json", color: false },
      json,
      configuredDependencies(config),
    );
    const formatting = jsonResult.checks.find(({ id }) => id === "formatting");
    expect(formatting?.configuration.overrides[0]?.files).toEqual(
      hostilePatterns,
    );
    expect(
      JSON.parse(json.stdout.join("")).checks.find(
        ({ id }: { id: string }) => id === "formatting",
      ).configuration.overrides[0].files,
    ).toEqual(hostilePatterns);

    const text = terminal();
    await executeChecksCommand(
      { cwd: "/repo", format: "text", color: false },
      text,
      configuredDependencies(config),
    );
    const output = text.stdout.join("");
    expect(output).toContain(
      "Override src/\\u001b[31mred/**, docs/line\\u000abreak/**, ui/\\u202ereversed/**",
    );
    expect(output).toContain("[truncated]");
    expect(output).toContain("(+4 patterns)");
    expect(output).toContain("settings.tabWidth: 4");
    expect(output).not.toContain("\u001b[31m");
    expect(output).not.toContain("line\nbreak/**");
    expect(output).not.toContain("\u202e");
    expect(output).not.toContain(hostilePatterns[3]);
    expect(output).not.toMatch(/\u001b\[[0-9;]*m/u);
  });

  it("detaches and deep-freezes nested configuration values in descriptions", async () => {
    const repositoryOption = {
      selector: "CallExpression",
      options: { allow: ["warn"] },
    };
    const overrideOption = {
      selector: "Identifier",
      options: { allow: ["error"] },
    };
    const repositoryRule = ["warn", repositoryOption];
    const overrideRule = ["error", overrideOption];
    const result = await executeChecksCommand(
      { cwd: "/repo", format: "json", color: false },
      terminal(),
      configuredDependencies(
        configWithMutableLintRule(repositoryRule, overrideRule),
      ),
    );
    const lint = result.checks.find(({ id }) => id === "lint")!;
    const describedRule = lint.configuration.values[
      "rules.no-restricted-syntax"
    ]!.value as readonly [
      string,
      { selector: string; options: { allow: string[] } },
    ];
    const describedOverrideRule = lint.configuration.overrides[0]!.values[
      "rules.no-alert"
    ] as readonly [string, { selector: string; options: { allow: string[] } }];

    repositoryRule[0] = "off";
    repositoryOption.selector = "Mutated";
    repositoryOption.options.allow.push("confirm");
    overrideRule[0] = "off";
    overrideOption.selector = "MutatedOverride";
    overrideOption.options.allow.push("prompt");

    expect(describedRule).toEqual([
      "warn",
      { selector: "CallExpression", options: { allow: ["warn"] } },
    ]);
    expect(describedOverrideRule).toEqual([
      "error",
      { selector: "Identifier", options: { allow: ["error"] } },
    ]);
    expect(Object.isFrozen(describedRule)).toBe(true);
    expect(Object.isFrozen(describedRule[1])).toBe(true);
    expect(Object.isFrozen(describedRule[1].options)).toBe(true);
    expect(Object.isFrozen(describedRule[1].options.allow)).toBe(true);
    expect(Object.isFrozen(describedOverrideRule)).toBe(true);
    expect(Object.isFrozen(describedOverrideRule[1])).toBe(true);
    expect(() => {
      (describedRule as unknown as string[])[0] = "off";
    }).toThrow(TypeError);
  });

  it("uses code-point-safe bounded terminal value previews with explicit truncation markers", async () => {
    const longText = `${"😀".repeat(140)}\u001b[31m${"tail".repeat(80)}`;
    const config = configWithMutableLintRule(
      [
        "warn",
        {
          selector: longText,
          values: Array.from({ length: 80 }, (_, index) => ({
            index,
            label: `entry-${index}`,
          })),
        },
      ],
      ["error", { selector: "Identifier" }],
    );

    const io = terminal();
    await executeChecksCommand(
      { cwd: "/repo", format: "text", color: false },
      io,
      configuredDependencies(config),
    );

    const output = io.stdout.join("");
    expect(output).toContain("rules.no-restricted-syntax:");
    expect(output).toContain("[truncated]");
    expect(output).toContain("\\u001b");
    expect(output).not.toContain("\u001b[31m");
    expect(hasUnpairedSurrogate(output)).toBe(false);
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
