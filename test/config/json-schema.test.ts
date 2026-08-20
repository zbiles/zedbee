import { Ajv } from "ajv";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  generateConfigJsonSchema,
  serializeConfigJsonSchema,
} from "../../src/config/json-schema.js";
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
      formatting: "warn",
      cyclomaticComplexity: {
        severity: "error",
        when: "always",
        max: 24,
        blockWorsening: true,
      },
      duplication: { threshold: 3.5 },
      vulnerabilities: { onUnavailable: "warn" },
    },
    overrides: [
      {
        files: ["packages/web/**/*.tsx"],
        checks: {
          reactAccessibility: "error",
          vulnerabilities: { severity: "warn", when: "relevant" },
        },
      },
    ],
    failOnIncomplete: false,
  },
] as const;

const validSourceExcerptPolicies = ["never", "interactive", "always"] as const;
const validTerminalFindingLimits = [1, 25, "all"] as const;
const validTemporaryReportRetentions = [1, 5, 9] as const;

function validator() {
  const ajv = new Ajv({ allErrors: true });
  return ajv.compile(generateConfigJsonSchema());
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

  it.each(validTemporaryReportRetentions)(
    "accepts the %s subsequent-scan temporary report retention in both validators",
    (temporaryReportRetention) => {
      const input = {
        schemaVersion: 1,
        reporting: { temporaryReportRetention },
      };
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
      name: "unknown reporting key",
      input: { schemaVersion: 1, reporting: { surprise: true } },
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
      name: "zero temporary report retention",
      input: { schemaVersion: 1, reporting: { temporaryReportRetention: 0 } },
    },
    {
      name: "negative temporary report retention",
      input: {
        schemaVersion: 1,
        reporting: { temporaryReportRetention: -1 },
      },
    },
    {
      name: "fractional temporary report retention",
      input: {
        schemaVersion: 1,
        reporting: { temporaryReportRetention: 1.5 },
      },
    },
    {
      name: "unsafe temporary report retention",
      input: {
        schemaVersion: 1,
        reporting: { temporaryReportRetention: 9_007_199_254_740_992 },
      },
    },
    {
      name: "numeric string temporary report retention",
      input: {
        schemaVersion: 1,
        reporting: { temporaryReportRetention: "5" },
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
          properties: {
            duplication: { description: string };
            vulnerabilities: { description: string };
          };
        };
        overrides: { default: unknown[]; description: string };
        reporting: {
          properties: {
            sourceExcerpts: { default: string };
            terminalFindingLimit: { default: number };
            temporaryReportRetention: { default: number };
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
            temporaryReportRetention: { default: 5 },
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
    expect(schema.properties.overrides.description).not.toBe("");
    expect(schema.properties.failOnIncomplete.description).not.toBe("");
    expect(configFileSchema.parse({ schemaVersion: 1 })).toEqual({
      schemaVersion: 1,
    });
  });

  it("keeps the checked-in schema byte-for-byte deterministic", async () => {
    const checkedIn = await readFile(
      resolve(import.meta.dirname, "../../schema/zedbee.schema.json"),
      "utf8",
    );

    expect(checkedIn).toBe(await serializeConfigJsonSchema());
  });
});
