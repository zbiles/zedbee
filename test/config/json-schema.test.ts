import { Ajv } from "ajv";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  generateConfigJsonSchema,
  serializeConfigJsonSchema,
} from "../../src/config/json-schema.js";
import { DISPLAY_TEXT_LIMITS } from "../../src/core/display-text.js";
import { CHECK_IDS, configFileSchema } from "../../src/config/schema.js";

const validExamples = [
  {
    schemaVersion: 1,
    profile: "recommended",
  },
  {
    $schema: "./node_modules/zedbee/schema/zedbee.schema.json",
    schemaVersion: 1,
    profile: "thorough",
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
          singleAttributePerLine: true,
        },
      },
      cyclomaticComplexity: {
        severity: "error",
        when: "always",
        max: 24,
        blockWorsening: true,
      },
      duplication: {
        threshold: 3.5,
        settings: { minLines: 8, minTokens: 60, mode: "strict" },
      },
      vulnerabilities: { onUnavailable: "warn" },
      lint: {
        rules: {
          "no-console": "warn",
          "@typescript-eslint/no-unused-vars": [
            "error",
            { argsIgnorePattern: "^_" },
          ],
        },
      },
      reactCorrectness: {
        rules: {
          "react/prop-types": "off",
          "react-hooks/rules-of-hooks": "error",
        },
      },
      reactAccessibility: {
        rules: { "jsx-a11y/no-autofocus": "off" },
      },
    },
    overrides: [
      {
        files: ["packages/web/**/*.tsx"],
        checks: {
          reactAccessibility: {
            severity: "error",
            rules: { "jsx-a11y/alt-text": "warn" },
          },
          vulnerabilities: { severity: "warn", when: "relevant" },
        },
      },
    ],
    failOnIncomplete: false,
  },
] as const;

const validSourceExcerptPolicies = ["never", "interactive", "always"] as const;
const validTerminalFindingLimits = [1, 25, "all"] as const;
const validTemporaryReportMaxAges = ["30m", "24h", "7d"] as const;
const validAgentGuidances = [
  {
    opening: "Read the complete report and follow TEAM.md.",
    nextStep: "Fix blocking findings before asking for review.",
  },
] as const;

function validator() {
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(generateConfigJsonSchema());
}

function rulePropertiesFor(checkId: string): Record<string, unknown> {
  const schema = generateConfigJsonSchema() as {
    properties: {
      checks: {
        properties: Record<
          string,
          { anyOf: [{ type: "string" }, { properties: { rules: unknown } }] }
        >;
      };
    };
  };
  const policyObjectSchema =
    schema.properties.checks.properties[checkId]?.anyOf[1];
  const rulesSchema = policyObjectSchema?.properties.rules as
    { properties?: Record<string, unknown> } | undefined;
  return rulesSchema?.properties ?? {};
}

describe("Zedbee configuration JSON Schema", () => {
  it("publishes each runtime check as one editor-visible property", () => {
    const schema = generateConfigJsonSchema() as {
      properties: {
        checks: { properties: Record<string, unknown> };
      };
    };

    expect(Object.keys(schema.properties.checks.properties)).toEqual(CHECK_IDS);
  });

  it.each(validExamples)("accepts a configuration accepted by Zod", (input) => {
    const validate = validator();

    expect(configFileSchema.safeParse(input).success).toBe(true);
    expect(validate(input), validate.errors?.map(String).join("\n")).toBe(true);
  });

  it.each(validSourceExcerptPolicies)(
    "accepts the %s source excerpt policy in both validators",
    (sourceExcerpts) => {
      const input = { schemaVersion: 1, reporting: { sourceExcerpts } };
      const validate = validator();

      expect(configFileSchema.safeParse(input).success).toBe(true);
      expect(validate(input), validate.errors?.map(String).join("\n")).toBe(
        true,
      );
    },
  );

  it.each(validTerminalFindingLimits)(
    "accepts the %s terminal finding limit in both validators",
    (terminalFindingLimit) => {
      const input = { schemaVersion: 1, reporting: { terminalFindingLimit } };
      const validate = validator();

      expect(configFileSchema.safeParse(input).success).toBe(true);
      expect(validate(input), validate.errors?.map(String).join("\n")).toBe(
        true,
      );
    },
  );

  it.each(validTemporaryReportMaxAges)(
    "accepts the %s temporary report maximum age in both validators",
    (temporaryReportMaxAge) => {
      const input = {
        schemaVersion: 1,
        reporting: { temporaryReportMaxAge },
      };
      const validate = validator();

      expect(configFileSchema.safeParse(input).success).toBe(true);
      expect(validate(input), validate.errors?.map(String).join("\n")).toBe(
        true,
      );
    },
  );

  it.each(validAgentGuidances)(
    "accepts safe agent guidance in both validators",
    (agentGuidance) => {
      const input = { schemaVersion: 1, reporting: { agentGuidance } };
      const validate = validator();

      expect(configFileSchema.safeParse(input).success).toBe(true);
      expect(validate(input), validate.errors?.map(String).join("\n")).toBe(
        true,
      );
    },
  );

  it.each([
    {
      name: "unknown root key",
      input: { schemaVersion: 1, surprise: true },
    },
    {
      name: "unknown check",
      input: { schemaVersion: 1, checks: { mystery: "error" } },
    },
    {
      name: "unknown formatting setting",
      input: {
        schemaVersion: 1,
        checks: { formatting: { settings: { parser: "typescript" } } },
      },
    },
    {
      name: "unreleased mistaken formatting setting",
      input: {
        schemaVersion: 1,
        checks: {
          formatting: {
            settings: { embeddedLanguageFormatting: "off" },
          },
        },
      },
    },
    {
      name: "invalid formatting numeric setting",
      input: {
        schemaVersion: 1,
        checks: { formatting: { settings: { printWidth: 0 } } },
      },
    },
    {
      name: "invalid formatting enum setting",
      input: {
        schemaVersion: 1,
        checks: { formatting: { settings: { trailingComma: "sometimes" } } },
      },
    },
    {
      name: "unknown duplication setting",
      input: {
        schemaVersion: 1,
        checks: { duplication: { settings: { minimumLines: 5 } } },
      },
    },
    {
      name: "invalid duplication numeric setting",
      input: {
        schemaVersion: 1,
        checks: { duplication: { settings: { minTokens: 0 } } },
      },
    },
    {
      name: "invalid duplication enum setting",
      input: {
        schemaVersion: 1,
        checks: { duplication: { settings: { mode: "medium" } } },
      },
    },
    {
      name: "unknown reporting key",
      input: { schemaVersion: 1, reporting: { surprise: true } },
    },
    {
      name: "unsafe agent guidance",
      input: {
        schemaVersion: 1,
        reporting: { agentGuidance: { opening: "unsafe\u001b[2J" } },
      },
    },
    {
      name: "oversized agent guidance",
      input: {
        schemaVersion: 1,
        reporting: {
          agentGuidance: {
            nextStep: "a".repeat(DISPLAY_TEXT_LIMITS.prose + 1),
          },
        },
      },
    },
    {
      name: "zero terminal finding limit",
      input: { schemaVersion: 1, reporting: { terminalFindingLimit: 0 } },
    },
    {
      name: "negative terminal finding limit",
      input: { schemaVersion: 1, reporting: { terminalFindingLimit: -1 } },
    },
    {
      name: "fractional terminal finding limit",
      input: { schemaVersion: 1, reporting: { terminalFindingLimit: 1.5 } },
    },
    {
      name: "unsafe terminal finding limit",
      input: {
        schemaVersion: 1,
        reporting: { terminalFindingLimit: 9_007_199_254_740_992 },
      },
    },
    {
      name: "numeric string terminal finding limit",
      input: { schemaVersion: 1, reporting: { terminalFindingLimit: "25" } },
    },
    {
      name: "numeric temporary report maximum age",
      input: { schemaVersion: 1, reporting: { temporaryReportMaxAge: 0 } },
    },
    {
      name: "negative numeric temporary report maximum age",
      input: {
        schemaVersion: 1,
        reporting: { temporaryReportMaxAge: -1 },
      },
    },
    {
      name: "fractional numeric temporary report maximum age",
      input: {
        schemaVersion: 1,
        reporting: { temporaryReportMaxAge: 1.5 },
      },
    },
    {
      name: "unsafe numeric temporary report maximum age",
      input: {
        schemaVersion: 1,
        reporting: { temporaryReportMaxAge: 9_007_199_254_740_992 },
      },
    },
    {
      name: "duration without a unit",
      input: {
        schemaVersion: 1,
        reporting: { temporaryReportMaxAge: "5" },
      },
    },
    {
      name: "zero temporary report maximum age",
      input: { schemaVersion: 1, reporting: { temporaryReportMaxAge: "0h" } },
    },
    {
      name: "fractional temporary report maximum age",
      input: {
        schemaVersion: 1,
        reporting: { temporaryReportMaxAge: "1.5h" },
      },
    },
    {
      name: "file-scoped OSV availability policy",
      input: {
        schemaVersion: 1,
        overrides: [
          {
            files: ["packages/web/**"],
            checks: { vulnerabilities: { onUnavailable: "warn" } },
          },
        ],
      },
    },
    {
      name: "file-scoped duplication threshold",
      input: {
        schemaVersion: 1,
        overrides: [
          {
            files: ["packages/web/**"],
            checks: { duplication: { threshold: 7.5 } },
          },
        ],
      },
    },
    {
      name: "file-scoped duplication settings",
      input: {
        schemaVersion: 1,
        overrides: [
          {
            files: ["packages/web/**"],
            checks: { duplication: { settings: { minLines: 8 } } },
          },
        ],
      },
    },
    {
      name: "absolute override glob",
      input: {
        schemaVersion: 1,
        overrides: [{ files: ["/packages/web/**"], checks: {} }],
      },
    },
    {
      name: "parent-traversing override glob",
      input: {
        schemaVersion: 1,
        overrides: [{ files: ["packages/../outside/**"], checks: {} }],
      },
    },
    {
      name: "empty normalized override glob",
      input: {
        schemaVersion: 1,
        overrides: [{ files: ["./"], checks: {} }],
      },
    },
  ])("rejects $name in both validators", ({ input }) => {
    const validate = validator();

    expect(configFileSchema.safeParse(input).success).toBe(false);
    expect(validate(input)).toBe(false);
  });

  it("exposes editor help and resolved defaults without changing Zod parsing", () => {
    const schema = generateConfigJsonSchema() as {
      title: string;
      description: string;
      properties: {
        schemaVersion: { default: number; description: string };
        profile: { default: string; description: string };
        checks: {
          default: object;
          description: string;
          properties: Record<string, { description: string } | undefined> & {
            duplication: { description: string };
            vulnerabilities: { description: string };
          };
        };
        overrides: { default: unknown[]; description: string };
        reporting: {
          properties: {
            sourceExcerpts: { default: string };
            terminalFindingLimit: { default: number };
            temporaryReportMaxAge: { default: string };
            agentGuidance: {
              properties: {
                opening: { maxLength: number };
                nextStep: { maxLength: number };
              };
            };
          };
        };
        failOnIncomplete: { default: boolean; description: string };
      };
    };

    expect(schema).toMatchObject({
      title: "Zedbee configuration",
      properties: {
        schemaVersion: { default: 1 },
        profile: { default: "recommended" },
        checks: { default: {} },
        overrides: { default: [] },
        reporting: {
          properties: {
            sourceExcerpts: { default: "interactive" },
            terminalFindingLimit: { default: 25 },
            temporaryReportMaxAge: { default: "24h" },
            agentGuidance: {
              properties: {
                opening: { maxLength: DISPLAY_TEXT_LIMITS.prose },
                nextStep: { maxLength: DISPLAY_TEXT_LIMITS.prose },
              },
            },
          },
        },
        failOnIncomplete: { default: true },
      },
    });
    expect(schema.description).not.toBe("");
    expect(schema.properties.schemaVersion.description).not.toBe("");
    expect(schema.properties.profile.description).not.toBe("");
    expect(schema.properties.checks.description).not.toBe("");
    expect(
      schema.properties.checks.properties.duplication.description,
    ).toContain("threshold");
    expect(
      schema.properties.checks.properties.vulnerabilities.description,
    ).toMatch(/online/i);
    expect(JSON.stringify(schema.properties.checks.properties.lint)).toContain(
      "rules",
    );
    expect(
      JSON.stringify(schema.properties.checks.properties.reactCorrectness),
    ).toContain("rules");
    expect(
      JSON.stringify(schema.properties.checks.properties.reactAccessibility),
    ).toContain("rules");
    expect(schema.properties.overrides.description).not.toBe("");
    expect(schema.properties.failOnIncomplete.description).not.toBe("");
    expect(configFileSchema.parse({ schemaVersion: 1 })).toEqual({
      schemaVersion: 1,
    });
  });

  it.each([
    {
      checkId: "lint",
      owned: ["no-console", "@typescript-eslint/no-unused-vars"],
      notOwned: ["jsx-a11y/no-autofocus", "company/private-rule"],
    },
    {
      checkId: "reactCorrectness",
      owned: ["react/prop-types", "react-hooks/rules-of-hooks"],
      notOwned: ["jsx-a11y/no-autofocus", "company/private-rule"],
    },
    {
      checkId: "reactAccessibility",
      owned: ["jsx-a11y/no-autofocus"],
      notOwned: ["react/prop-types", "company/private-rule"],
    },
  ])(
    "exposes bounded known rule IDs for $checkId",
    ({ checkId, owned, notOwned }) => {
      const properties = rulePropertiesFor(checkId);

      for (const ruleId of owned) {
        expect(properties).toHaveProperty(ruleId);
      }
      for (const ruleId of notOwned) {
        expect(properties).not.toHaveProperty(ruleId);
      }
    },
  );

  it.each([
    {
      name: "lint owned rule",
      input: {
        schemaVersion: 1,
        checks: { lint: { rules: { "no-console": "warn" } } },
      },
      valid: true,
    },
    {
      name: "lint wrong-check rule",
      input: {
        schemaVersion: 1,
        checks: { lint: { rules: { "jsx-a11y/no-autofocus": "warn" } } },
      },
      valid: false,
    },
    {
      name: "react accessibility owned rule",
      input: {
        schemaVersion: 1,
        checks: {
          reactAccessibility: { rules: { "jsx-a11y/no-autofocus": "off" } },
        },
      },
      valid: true,
    },
    {
      name: "react accessibility unknown rule",
      input: {
        schemaVersion: 1,
        checks: {
          reactAccessibility: { rules: { "company/private-rule": "error" } },
        },
      },
      valid: false,
    },
  ])(
    "keeps runtime and generated schema acceptance aligned for $name",
    ({ input, valid }) => {
      const validate = validator();

      expect(configFileSchema.safeParse(input).success).toBe(valid);
      expect(validate(input)).toBe(valid);
    },
  );

  it("keeps the checked-in schema byte-for-byte deterministic", async () => {
    const checkedIn = await readFile(
      resolve(import.meta.dirname, "../../schema/zedbee.schema.json"),
      "utf8",
    );

    expect(checkedIn).toBe(await serializeConfigJsonSchema());
  });
});
