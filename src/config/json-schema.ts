import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "prettier";
import { z } from "zod";
import {
  managedRuleInventory,
  type RuleCheckId,
} from "../checks/eslint/rule-settings.js";
import { configFileSchema } from "./schema.js";

export type ConfigJsonSchema = Record<string, unknown>;

const schemaPath = resolve(
  import.meta.dirname,
  "../../schema/zedbee.schema.json",
);

const RULE_CHECK_IDS = [
  "lint",
  "reactCorrectness",
  "reactAccessibility",
] as const satisfies readonly RuleCheckId[];
const RULE_CONFIGURATION_DEFINITION = "managedEslintRuleConfiguration";

function ruleSeverityJsonSchema(): ConfigJsonSchema {
  return {
    anyOf: [
      {
        type: "string",
        enum: ["off", "warn", "error"],
        description:
          "Whether a rule is disabled, reports a warning, or reports an error.",
      },
      {
        type: "number",
        enum: [0, 1, 2],
      },
    ],
  };
}

function ruleConfigurationJsonSchema(): ConfigJsonSchema {
  return {
    anyOf: [
      ruleSeverityJsonSchema(),
      {
        type: "array",
        minItems: 1,
        items: [ruleSeverityJsonSchema()],
        additionalItems: true,
      },
    ],
    description:
      'ESLint rule severity ("off", "warn", "error", 0, 1, 2) or [severity, ...options].',
  };
}

function ruleConfigurationJsonSchemaReference(): ConfigJsonSchema {
  return { $ref: `#/definitions/${RULE_CONFIGURATION_DEFINITION}` };
}

function boundedRuleSettingsJsonSchema(checkId: RuleCheckId): ConfigJsonSchema {
  return {
    type: "object",
    properties: Object.fromEntries(
      [...managedRuleInventory(checkId).keys()]
        .sort()
        .map((ruleId) => [ruleId, ruleConfigurationJsonSchemaReference()]),
    ),
    additionalProperties: false,
    description:
      "Managed rule overrides for known core, TypeScript ESLint, React, Hooks, or JSX accessibility rule IDs.",
  };
}

function patchRuleSettingsSchema(
  checksProperties: Record<string, Record<string, unknown>> | undefined,
): void {
  if (checksProperties === undefined) return;

  for (const checkId of RULE_CHECK_IDS) {
    const policySchema = checksProperties[checkId] as
      { anyOf?: unknown[] } | undefined;
    const objectSchema = policySchema?.anyOf?.find(
      (candidate): candidate is { properties?: Record<string, unknown> } =>
        typeof candidate === "object" &&
        candidate !== null &&
        "properties" in candidate,
    );
    if (objectSchema?.properties?.rules !== undefined) {
      objectSchema.properties.rules = boundedRuleSettingsJsonSchema(checkId);
    }
  }
}

export function generateConfigJsonSchema(): ConfigJsonSchema {
  const generated = z.toJSONSchema(configFileSchema, {
    target: "draft-07",
    io: "input",
  });
  const schema = JSON.parse(JSON.stringify(generated)) as ConfigJsonSchema;
  schema.definitions = {
    ...((schema.definitions as Record<string, unknown> | undefined) ?? {}),
    [RULE_CONFIGURATION_DEFINITION]: ruleConfigurationJsonSchema(),
  };
  const properties = schema.properties as
    Record<string, Record<string, unknown>> | undefined;

  // Zod currently omits empty metadata defaults on nested input schemas.
  // Restore the runtime defaults explicitly for editor completion.
  if (properties?.checks !== undefined) {
    properties.checks.default = {};
  }
  if (properties?.overrides !== undefined) {
    properties.overrides.default = [];
  }
  patchRuleSettingsSchema(
    (
      properties?.checks as
        { properties?: Record<string, Record<string, unknown>> } | undefined
    )?.properties,
  );
  patchRuleSettingsSchema(
    (
      (
        properties?.overrides as
          { items?: { properties?: Record<string, unknown> } } | undefined
      )?.items?.properties?.checks as
        { properties?: Record<string, Record<string, unknown>> } | undefined
    )?.properties,
  );

  return schema;
}

export async function serializeConfigJsonSchema(): Promise<string> {
  return format(JSON.stringify(generateConfigJsonSchema(), null, 2), {
    parser: "json",
    endOfLine: "lf",
  });
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const generated = await serializeConfigJsonSchema();

  if (mode === "--write") {
    await writeFile(schemaPath, generated, "utf8");
    process.stdout.write("Configuration schema updated.\n");
    return;
  }

  if (mode === "--check") {
    const checkedIn = await readFile(schemaPath, "utf8").catch(() => "");
    if (checkedIn !== generated) {
      throw new Error(
        "Configuration schema is stale; run npm run schema:generate.",
      );
    }
    process.stdout.write("Configuration schema is current.\n");
    return;
  }

  throw new Error("Expected --write or --check.");
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Schema command failed."}\n`,
    );
    process.exitCode = 1;
  });
}
