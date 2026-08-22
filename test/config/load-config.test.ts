import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { loadConfig } from "../../src/config/load-config.js";

async function createRepositoryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zedbee-config-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("loadConfig", () => {
  it("uses the recommended profile when no config exists", async () => {
    const root = await createRepositoryRoot();

    const config = await loadConfig(root);

    expect(config.schemaVersion).toBe(1);
    expect(config.profile).toBe("recommended");
    expect(config.checks.formatting).toEqual({
      severity: "error",
      when: "relevant",
      settings: {
        printWidth: 80,
        tabWidth: 2,
        useTabs: false,
        semi: true,
        singleQuote: false,
        quoteProps: "as-needed",
        jsxSingleQuote: false,
        trailingComma: "all",
        bracketSpacing: true,
        bracketSameLine: false,
        arrowParens: "always",
        proseWrap: "preserve",
        endOfLine: "lf",
        singleAttributePerLine: false,
      },
    });
    expect(config.checks.types).toEqual({
      severity: "error",
      when: "relevant",
    });
    expect(config.checks.duplication).toEqual({
      severity: "off",
      when: "relevant",
      threshold: 5,
      settings: { minLines: 5, minTokens: 50, mode: "mild" },
    });
    expect(config.failOnIncomplete).toBe(true);
    expect(config.overrides).toEqual([]);
    expect(config.reporting).toEqual({
      sourceExcerpts: "interactive",
      terminalFindingLimit: 25,
      temporaryReportMaxAge: "24h",
      agentGuidance: {
        opening: "",
        nextStep: "",
      },
    });
  });

  it("applies the configured reporting policy", async () => {
    const root = await createRepositoryRoot();
    await writeFile(
      join(root, ".zedbeerc.jsonc"),
      JSON.stringify({
        schemaVersion: 1,
        reporting: {
          sourceExcerpts: "always",
          terminalFindingLimit: "all",
          temporaryReportMaxAge: "7d",
          agentGuidance: {
            opening: "Read the complete report and follow TEAM.md.",
            nextStep: "Fix blocking findings before asking for review.",
          },
        },
      }),
    );

    expect((await loadConfig(root)).reporting).toEqual({
      sourceExcerpts: "always",
      terminalFindingLimit: "all",
      temporaryReportMaxAge: "7d",
      agentGuidance: {
        opening: "Read the complete report and follow TEAM.md.",
        nextStep: "Fix blocking findings before asking for review.",
      },
    });
  });

  it("normalizes whitespace-only agent guidance to blank strings", async () => {
    const root = await createRepositoryRoot();
    await writeFile(
      join(root, ".zedbeerc.jsonc"),
      JSON.stringify({
        schemaVersion: 1,
        reporting: {
          agentGuidance: { opening: "   ", nextStep: "  " },
        },
      }),
    );

    expect((await loadConfig(root)).reporting.agentGuidance).toEqual({
      opening: "",
      nextStep: "",
    });
  });

  it("parses comments and applies per-check overrides", async () => {
    const root = await createRepositoryRoot();
    const configPath = join(root, ".zedbeerc.jsonc");
    await writeFile(
      configPath,
      `{
        // Repository policy
        "schemaVersion": 1,
        "profile": "fast",
        "checks": {
          "formatting": { "severity": "warn", "when": "always" }
        }
      }`,
    );

    const config = await loadConfig(root);

    expect(config.schemaVersion).toBe(1);
    expect(config.profile).toBe("fast");
    expect(config.checks.formatting).toEqual({
      severity: "warn",
      when: "always",
      settings: {
        printWidth: 80,
        tabWidth: 2,
        useTabs: false,
        semi: true,
        singleQuote: false,
        quoteProps: "as-needed",
        jsxSingleQuote: false,
        trailingComma: "all",
        bracketSpacing: true,
        bracketSameLine: false,
        arrowParens: "always",
        proseWrap: "preserve",
        endOfLine: "lf",
        singleAttributePerLine: false,
      },
    });
    expect(config.checks.types).toEqual({ severity: "off", when: "relevant" });
    expect(config.failOnIncomplete).toBe(true);
    expect(config.overrides).toEqual([]);
    expect(config.configPath).toBe(configPath);
  });

  it("supports severity shorthand and fail-open override", async () => {
    const root = await createRepositoryRoot();
    await writeFile(
      join(root, ".zedbeerc.jsonc"),
      JSON.stringify({
        schemaVersion: 1,
        profile: "thorough",
        checks: { formatting: "off" },
        failOnIncomplete: false,
      }),
    );

    const config = await loadConfig(root);

    expect(config.checks.formatting).toEqual({
      severity: "off",
      when: "relevant",
      settings: {
        printWidth: 80,
        tabWidth: 2,
        useTabs: false,
        semi: true,
        singleQuote: false,
        quoteProps: "as-needed",
        jsxSingleQuote: false,
        trailingComma: "all",
        bracketSpacing: true,
        bracketSameLine: false,
        arrowParens: "always",
        proseWrap: "preserve",
        endOfLine: "lf",
        singleAttributePerLine: false,
      },
    });
    expect(config.failOnIncomplete).toBe(false);
  });

  it("loads an explicit JSONC path selected by the CLI", async () => {
    const root = await createRepositoryRoot();
    const configPath = join(root, "config", "zedbee.jsonc");
    await mkdir(join(root, "config"), { recursive: true });
    await writeFile(
      configPath,
      '{"schemaVersion":1,"profile":"fast","checks":{"formatting":"warn"}}',
    );

    const config = await loadConfig(root, configPath);

    expect(config.profile).toBe("fast");
    expect(config.checks.formatting.severity).toBe("warn");
    expect(config.configPath).toBe(configPath);
  });

  it("accepts only the supported option fields for each managed check", async () => {
    const root = await createRepositoryRoot();
    await writeFile(
      join(root, ".zedbeerc.jsonc"),
      JSON.stringify({
        schemaVersion: 1,
        checks: {
          formatting: { settings: { printWidth: 100, singleQuote: true } },
          lint: { when: "always" },
          cyclomaticComplexity: { max: 20, blockWorsening: true },
          readabilityComplexity: {
            severity: "warn",
            max: 15,
            blockWorsening: false,
          },
          duplication: { threshold: 5, settings: { mode: "weak" } },
          reactCorrectness: { severity: "warn" },
          reactAccessibility: { when: "always" },
          vulnerabilities: { onUnavailable: "warn" },
        },
      }),
    );

    const config = await loadConfig(root);

    expect(config.checks.formatting).toMatchObject({
      severity: "error",
      when: "relevant",
      settings: {
        printWidth: 100,
        tabWidth: 2,
        singleQuote: true,
      },
    });
    expect(config.checks.lint).toEqual({
      severity: "error",
      when: "always",
      rules: {},
    });
    expect(config.checks.cyclomaticComplexity).toEqual({
      severity: "error",
      when: "relevant",
      max: 20,
      blockWorsening: true,
    });
    expect(config.checks.readabilityComplexity).toEqual({
      severity: "warn",
      when: "relevant",
      max: 15,
      blockWorsening: false,
    });
    expect(config.checks.duplication).toEqual({
      severity: "off",
      when: "relevant",
      threshold: 5,
      settings: { minLines: 5, minTokens: 50, mode: "weak" },
    });
    expect(config.checks.reactCorrectness).toMatchObject({
      severity: "warn",
      rules: {},
    });
    expect(config.checks.reactAccessibility).toMatchObject({
      when: "always",
      rules: {},
    });
    expect(config.checks.vulnerabilities).toEqual({
      severity: "off",
      when: "relevant",
      onUnavailable: "warn",
    });
  });

  it.each([
    ".zedbeerc.js",
    ".zedbeerc.cjs",
    ".zedbeerc.mjs",
    ".zedbeerc.ts",
    ".zedbeerc.json",
  ])("rejects unsupported configuration file %s", async (filename) => {
    const root = await createRepositoryRoot();
    await writeFile(join(root, filename), "export default {};\n");

    await expect(loadConfig(root)).rejects.toMatchObject({
      code: "CONFIG_UNSUPPORTED",
    });
  });

  it.each([
    {
      name: "unsupported schema version",
      source: '{"schemaVersion":2,"profile":"fast"}',
    },
    {
      name: "unknown check",
      source: '{"schemaVersion":1,"checks":{"mystery":"error"}}',
    },
    {
      name: "invalid severity",
      source: '{"schemaVersion":1,"checks":{"formatting":"fatal"}}',
    },
    {
      name: "invalid duplication threshold",
      source:
        '{"schemaVersion":1,"checks":{"duplication":{"severity":"error","threshold":-1}}}',
    },
    {
      name: "threshold on a check that does not support it",
      source:
        '{"schemaVersion":1,"checks":{"lint":{"severity":"error","threshold":5}}}',
    },
    {
      name: "invalid vulnerability availability mode",
      source:
        '{"schemaVersion":1,"checks":{"vulnerabilities":{"severity":"error","onUnavailable":"sometimes"}}}',
    },
    {
      name: "obsolete offline vulnerability mode",
      source:
        '{"schemaVersion":1,"checks":{"vulnerabilities":{"severity":"error","network":"offline"}}}',
    },
    {
      name: "availability mode on a non-vulnerability check",
      source:
        '{"schemaVersion":1,"checks":{"structuralSecurity":{"severity":"error","onUnavailable":"warn"}}}',
    },
    {
      name: "unknown per-check option",
      source:
        '{"schemaVersion":1,"checks":{"cyclomaticComplexity":{"severity":"error","maximum":20}}}',
    },
    {
      name: "unknown formatting setting",
      source:
        '{"schemaVersion":1,"checks":{"formatting":{"settings":{"filepath":"src/index.ts"}}}}',
    },
    {
      name: "unreleased mistaken formatting setting",
      source:
        '{"schemaVersion":1,"checks":{"formatting":{"settings":{"embeddedLanguageFormatting":"off"}}}}',
    },
    {
      name: "invalid formatting setting",
      source:
        '{"schemaVersion":1,"checks":{"formatting":{"settings":{"printWidth":0}}}}',
    },
    {
      name: "unknown duplication setting",
      source:
        '{"schemaVersion":1,"checks":{"duplication":{"settings":{"minimumLines":5}}}}',
    },
    {
      name: "invalid duplication mode",
      source:
        '{"schemaVersion":1,"checks":{"duplication":{"settings":{"mode":"medium"}}}}',
    },
    {
      name: "wrong-owner managed rule",
      source:
        '{"schemaVersion":1,"checks":{"lint":{"rules":{"jsx-a11y/no-autofocus":"warn"}}}}',
    },
    {
      name: "unsupported private rule",
      source:
        '{"schemaVersion":1,"checks":{"reactCorrectness":{"rules":{"company/private-rule":"error"}}}}',
    },
    {
      name: "invalid managed rule option",
      source:
        '{"schemaVersion":1,"overrides":[{"files":["packages/web/**"],"checks":{"lint":{"rules":{"no-restricted-syntax":["error",{"selector":42}]}}}}]}',
    },
    {
      name: "invalid source excerpt reporting policy",
      source: '{"schemaVersion":1,"reporting":{"sourceExcerpts":"sometimes"}}',
    },
    {
      name: "zero terminal finding limit",
      source: '{"schemaVersion":1,"reporting":{"terminalFindingLimit":0}}',
    },
    {
      name: "negative terminal finding limit",
      source: '{"schemaVersion":1,"reporting":{"terminalFindingLimit":-1}}',
    },
    {
      name: "fractional terminal finding limit",
      source: '{"schemaVersion":1,"reporting":{"terminalFindingLimit":1.5}}',
    },
    {
      name: "unsafe terminal finding limit",
      source:
        '{"schemaVersion":1,"reporting":{"terminalFindingLimit":9007199254740992}}',
    },
    {
      name: "numeric string terminal finding limit",
      source: '{"schemaVersion":1,"reporting":{"terminalFindingLimit":"25"}}',
    },
    {
      name: "numeric zero temporary report age",
      source: '{"schemaVersion":1,"reporting":{"temporaryReportMaxAge":0}}',
    },
    {
      name: "negative numeric temporary report age",
      source: '{"schemaVersion":1,"reporting":{"temporaryReportMaxAge":-1}}',
    },
    {
      name: "fractional numeric temporary report age",
      source: '{"schemaVersion":1,"reporting":{"temporaryReportMaxAge":1.5}}',
    },
    {
      name: "unsafe numeric temporary report age",
      source:
        '{"schemaVersion":1,"reporting":{"temporaryReportMaxAge":9007199254740992}}',
    },
    {
      name: "unitless temporary report age",
      source: '{"schemaVersion":1,"reporting":{"temporaryReportMaxAge":"5"}}',
    },
    {
      name: "unknown reporting setting",
      source: '{"schemaVersion":1,"reporting":{"unexpected":true}}',
    },
    {
      name: "malformed JSONC",
      source: '{"schemaVersion":1,"checks":',
    },
  ])("rejects $name without echoing source", async ({ source }) => {
    const root = await createRepositoryRoot();
    await writeFile(join(root, ".zedbeerc.jsonc"), source);

    const error = await loadConfig(root).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(String(error)).not.toContain(source);
  });

  it("reports the invalid setting path without echoing the invalid value", async () => {
    const root = await createRepositoryRoot();
    await writeFile(
      join(root, ".zedbeerc.jsonc"),
      '{"schemaVersion":1,"checks":{"formatting":{"settings":{"parser":"secret-parser-name"}}}}',
    );

    const error = await loadConfig(root).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(String(error)).toContain("checks.formatting.settings.parser");
    expect(String(error)).toContain("printWidth");
    expect(String(error)).not.toContain("secret-parser-name");
  });

  it("reports override setting paths with nearby supported setting names", async () => {
    const root = await createRepositoryRoot();
    await writeFile(
      join(root, ".zedbeerc.jsonc"),
      '{"schemaVersion":1,"overrides":[{"files":["packages/web/**"],"checks":{"formatting":{"settings":{"parser":"secret-parser-name"}}}}]}',
    );

    const error = await loadConfig(root).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(String(error)).toContain(
      "overrides.0.checks.formatting.settings.parser",
    );
    expect(String(error)).toContain("printWidth");
    expect(String(error)).not.toContain("secret-parser-name");
  });

  it("reports policy object paths with nearby supported policy fields", async () => {
    const root = await createRepositoryRoot();
    await writeFile(
      join(root, ".zedbeerc.jsonc"),
      '{"schemaVersion":1,"checks":{"cyclomaticComplexity":{"maximum":20}}}',
    );

    const error = await loadConfig(root).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(String(error)).toContain("checks.cyclomaticComplexity.maximum");
    expect(String(error)).toContain("max");
    expect(String(error)).toContain("blockWorsening");
  });

  it("omits supported-name suggestions when no nearby field is unambiguous", async () => {
    const root = await createRepositoryRoot();
    await writeFile(
      join(root, ".zedbeerc.jsonc"),
      '{"schemaVersion":1,"checks":{"mystery":"error"}}',
    );

    const error = await loadConfig(root).catch((reason: unknown) => reason);

    expect(error).toMatchObject({ code: "CONFIG_INVALID" });
    expect(String(error)).toContain("checks.mystery");
    expect(String(error)).not.toContain("Supported settings include");
  });

  it.each([
    {
      name: "missing files",
      override: { checks: { lint: "warn" } },
    },
    {
      name: "empty files",
      override: { files: [], checks: { lint: "warn" } },
    },
    {
      name: "empty pattern",
      override: { files: [""], checks: { lint: "warn" } },
    },
    {
      name: "parent traversal",
      override: { files: ["packages/../outside/**"], checks: { lint: "warn" } },
    },
    {
      name: "POSIX absolute path",
      override: { files: ["/packages/web/**"], checks: { lint: "warn" } },
    },
    {
      name: "Windows drive path",
      override: { files: ["C:/packages/web/**"], checks: { lint: "warn" } },
    },
    {
      name: "Windows UNC path",
      override: { files: ["//server/share/**"], checks: { lint: "warn" } },
    },
    {
      name: "backslash-obscured traversal",
      override: {
        files: ["packages\\..\\outside\\**"],
        checks: { lint: "warn" },
      },
    },
    {
      name: "unknown check",
      override: { files: ["packages/web/**"], checks: { mystery: "warn" } },
    },
    {
      name: "file-scoped availability policy",
      override: {
        files: ["packages/web/**"],
        checks: { vulnerabilities: { onUnavailable: "warn" } },
      },
    },
  ])("rejects an override with $name", async ({ override }) => {
    const root = await createRepositoryRoot();
    await writeFile(
      join(root, ".zedbeerc.jsonc"),
      JSON.stringify({ schemaVersion: 1, overrides: [override] }),
    );

    await expect(loadConfig(root)).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("preserves override declaration order, safe globs, and explicit patch fields", async () => {
    const root = await createRepositoryRoot();
    await writeFile(
      join(root, ".zedbeerc.jsonc"),
      JSON.stringify({
        schemaVersion: 1,
        overrides: [
          {
            files: ["packages/web/**", "apps/*/src/**/*.tsx"],
            checks: {
              reactAccessibility: "warn",
              cyclomaticComplexity: { max: 25 },
            },
          },
          {
            files: ["packages/web/test/**"],
            checks: {
              reactAccessibility: { when: "always" },
              cyclomaticComplexity: { blockWorsening: false },
            },
          },
        ],
      }),
    );

    const config = await loadConfig(root);

    expect(
      config.overrides.map(({ files, checks }) => ({ files, checks })),
    ).toEqual([
      {
        files: ["packages/web/**", "apps/*/src/**/*.tsx"],
        checks: {
          cyclomaticComplexity: { max: 25 },
          reactAccessibility: { severity: "warn" },
        },
      },
      {
        files: ["packages/web/test/**"],
        checks: {
          cyclomaticComplexity: { blockWorsening: false },
          reactAccessibility: { when: "always" },
        },
      },
    ]);
    expect(
      config.overrides[0]?.configurationOrigins.reactAccessibility,
    ).toEqual({
      severity: {
        kind: "override",
        index: 0,
        files: ["packages/web/**", "apps/*/src/**/*.tsx"],
      },
    });
    expect(
      config.overrides[1]?.configurationOrigins.cyclomaticComplexity,
    ).toEqual({
      blockWorsening: {
        kind: "override",
        index: 1,
        files: ["packages/web/test/**"],
      },
    });
  });
});
