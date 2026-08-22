import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/profiles.js";
import { CHECK_IDS, type CheckId } from "../../src/config/schema.js";

describe("managed check profiles", () => {
  it("resolves version-1 reporting defaults", () => {
    expect(resolveConfig(undefined).reporting).toEqual({
      sourceExcerpts: "interactive",
      terminalFindingLimit: 25,
      temporaryReportMaxAge: "24h",
      agentGuidance: { opening: "", nextStep: "" },
    });
  });

  it("resolves configured terminal presentation and maximum report age", () => {
    expect(
      resolveConfig({
        schemaVersion: 1,
        reporting: { terminalFindingLimit: "all", temporaryReportMaxAge: "7d" },
      }).reporting,
    ).toMatchObject({
      terminalFindingLimit: "all",
      temporaryReportMaxAge: "7d",
    });
  });

  it("publishes every managed check ID in stable order", () => {
    expect(CHECK_IDS).toEqual([
      "formatting",
      "lint",
      "types",
      "cyclomaticComplexity",
      "readabilityComplexity",
      "structuralSecurity",
      "secrets",
      "duplication",
      "dependencyArchitecture",
      "deadCode",
      "reactCorrectness",
      "reactAccessibility",
      "vulnerabilities",
    ]);
  });

  it.each([
    {
      profile: "fast" as const,
      enabled: [
        "formatting",
        "lint",
        "cyclomaticComplexity",
        "readabilityComplexity",
        "structuralSecurity",
        "reactCorrectness",
        "reactAccessibility",
      ],
      disabled: [
        "types",
        "secrets",
        "duplication",
        "dependencyArchitecture",
        "deadCode",
        "vulnerabilities",
      ],
    },
    {
      profile: "recommended" as const,
      enabled: [
        "formatting",
        "lint",
        "types",
        "cyclomaticComplexity",
        "readabilityComplexity",
        "structuralSecurity",
        "secrets",
        "reactCorrectness",
        "reactAccessibility",
      ],
      disabled: [
        "duplication",
        "dependencyArchitecture",
        "deadCode",
        "vulnerabilities",
      ],
    },
    {
      profile: "thorough" as const,
      enabled: [...CHECK_IDS],
      disabled: [],
    },
  ])(
    "resolves the $profile profile into complete policies",
    ({ profile, enabled, disabled }) => {
      const config = resolveConfig({ schemaVersion: 1, profile });

      expect(Object.keys(config.checks)).toEqual(CHECK_IDS);
      for (const checkId of enabled as readonly CheckId[]) {
        expect(config.checks[checkId]).toMatchObject({
          severity: "error",
          when: "relevant",
        });
      }
      for (const checkId of disabled as readonly CheckId[]) {
        expect(config.checks[checkId]).toMatchObject({
          severity: "off",
          when: "relevant",
        });
      }
    },
  );

  it("merges root check fields over complete profile defaults", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "fast",
      checks: {
        duplication: {
          severity: "warn",
          threshold: 5,
          settings: { minLines: 8, minTokens: 60, mode: "strict" },
        },
        cyclomaticComplexity: { max: 20, blockWorsening: true },
        vulnerabilities: { onUnavailable: "warn" },
      },
    });

    expect(config.checks.duplication).toEqual({
      severity: "warn",
      when: "relevant",
      threshold: 5,
      settings: { minLines: 8, minTokens: 60, mode: "strict" },
    });
    expect(config.checks.cyclomaticComplexity).toEqual({
      severity: "error",
      when: "relevant",
      max: 20,
      blockWorsening: true,
    });
    expect(config.checks.vulnerabilities).toEqual({
      severity: "off",
      when: "relevant",
      onUnavailable: "warn",
    });
  });

  it("defaults online vulnerability availability failures to blocking", () => {
    const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });

    expect(config.checks.vulnerabilities).toEqual({
      severity: "error",
      when: "relevant",
      onUnavailable: "block",
    });
  });

  it("supplies executable managed complexity defaults", () => {
    const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });

    expect(config.checks.cyclomaticComplexity).toMatchObject({
      max: 20,
      blockWorsening: true,
    });
    expect(config.checks.readabilityComplexity).toMatchObject({
      max: 15,
      blockWorsening: true,
    });
    expect(config.checks.duplication).toMatchObject({ threshold: 5 });
  });

  it("resolves complete formatting settings over managed defaults", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      checks: {
        formatting: {
          severity: "warn",
          settings: {
            printWidth: 100,
            tabWidth: 4,
            useTabs: true,
            semi: false,
            singleQuote: true,
            quoteProps: "consistent",
            jsxSingleQuote: true,
            trailingComma: "all",
            bracketSpacing: false,
            bracketSameLine: true,
            arrowParens: "avoid",
            proseWrap: "always",
            endOfLine: "lf",
            embeddedLanguageFormatting: "off",
          },
        },
      },
    });

    expect(config.checks.formatting).toEqual({
      severity: "warn",
      when: "relevant",
      settings: {
        printWidth: 100,
        tabWidth: 4,
        useTabs: true,
        semi: false,
        singleQuote: true,
        quoteProps: "consistent",
        jsxSingleQuote: true,
        trailingComma: "all",
        bracketSpacing: false,
        bracketSameLine: true,
        arrowParens: "avoid",
        proseWrap: "always",
        endOfLine: "lf",
        embeddedLanguageFormatting: "off",
      },
    });
  });

  it("keeps severity shorthand behavior while materializing managed defaults", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      checks: { formatting: "warn" },
    });

    expect(config.checks.formatting).toEqual({
      severity: "warn",
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
        embeddedLanguageFormatting: "auto",
      },
    });
  });
});
