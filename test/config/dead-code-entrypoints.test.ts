import { expect, it } from "vitest";
import { configFileSchema } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/profiles.js";
it("resolves and attributes immutable repository-only exact entries", () => {
  const file = configFileSchema.parse({
    schemaVersion: 1,
    checks: { deadCode: { entryPoints: ["web/index.html", "web/start.ts"] } },
  });
  const config = resolveConfig(file);
  expect(config.checks.deadCode.entryPoints).toEqual([
    "web/index.html",
    "web/start.ts",
  ]);
  expect(Object.isFrozen(config.checks.deadCode.entryPoints)).toBe(true);
  expect(config.configurationOrigins.deadCode.entryPoints?.kind).toBe(
    "repository",
  );
});
it.each([
  "../escape.ts",
  "/root.ts",
  "web/*.ts",
  "web\\main.ts",
  "web/../main.ts",
  "file:main.ts",
  "web/main.ts?raw",
])("rejects non-exact entry %s", (path) => {
  expect(
    configFileSchema.safeParse({
      schemaVersion: 1,
      checks: { deadCode: { entryPoints: [path] } },
    }).success,
  ).toBe(false);
});
it("rejects entry points in file overrides", () => {
  expect(
    configFileSchema.safeParse({
      schemaVersion: 1,
      overrides: [
        {
          files: ["**"],
          checks: { deadCode: { entryPoints: ["src/main.ts"] } },
        },
      ],
    }).success,
  ).toBe(false);
});

it("publishes matching exact-path constraints in the generated editor schema", async () => {
  const { Ajv } = await import("ajv");
  const { generateConfigJsonSchema } =
    await import("../../src/config/json-schema.js");
  const validate = new Ajv({ strict: false }).compile(
    generateConfigJsonSchema(),
  );
  for (const path of [
    "src/main.ts",
    "web/index.html",
    "../bad.ts",
    "/absolute.ts",
    "src/*.ts",
    "src/../bad.ts",
    "src//main.ts",
  ]) {
    const input = {
      schemaVersion: 1,
      checks: { deadCode: { entryPoints: [path] } },
    };
    expect(validate(input), path).toBe(
      configFileSchema.safeParse(input).success,
    );
  }
});
