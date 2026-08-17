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
      vulnerabilities: { network: "offline" },
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
      name: "file-scoped network policy",
      input: {
        schemaVersion: 1,
        overrides: [
          {
            files: ["packages/web/**"],
            checks: { vulnerabilities: { network: "offline" } },
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
          properties: { sourceExcerpts: { default: string } };
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
          properties: { sourceExcerpts: { default: "interactive" } },
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
    ).toContain("online");
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
