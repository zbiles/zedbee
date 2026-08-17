import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { format } from "prettier";
import { z } from "zod";
import { configFileSchema } from "./schema.js";

export type ConfigJsonSchema = Record<string, unknown>;

const schemaPath = resolve(
  import.meta.dirname,
  "../../schema/zedbee.schema.json",
);

export function generateConfigJsonSchema(): ConfigJsonSchema {
  const generated = z.toJSONSchema(configFileSchema, {
    target: "draft-07",
    io: "input",
  });
  const schema = JSON.parse(JSON.stringify(generated)) as ConfigJsonSchema;
  const properties = schema.properties as
    Record<string, Record<string, unknown>> | undefined;

  // Zod currently omits an empty-array metadata default on this nested input
  // schema. Restore the runtime default explicitly for editor completion.
  if (properties?.overrides !== undefined) {
    properties.overrides.default = [];
  }

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
