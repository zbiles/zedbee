import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Ajv } from "ajv";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { configFileSchema } from "../../src/config/schema.js";

const root = resolve(import.meta.dirname, "../..");
let scratch: string;

beforeAll(async () => {
  scratch = await mkdtemp(resolve(tmpdir(), "zedbee-config-schema-"));
});

afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("published configuration schema", () => {
  it("includes a reporting-aware configuration schema in the npm tarball", async () => {
    const packed = await execa(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
      {
        cwd: root,
        env: { npm_config_cache: resolve(scratch, "npm-cache") },
        reject: false,
        stdin: "ignore",
      },
    );

    expect(packed.exitCode, packed.stderr).toBe(0);
    const metadata = JSON.parse(packed.stdout) as Array<{
      filename: string;
      files: Array<{ path: string }>;
    }>;
    expect(metadata[0]?.files.map(({ path }) => path)).toContain(
      "schema/zedbee.schema.json",
    );

    const archive = metadata[0]?.filename;
    if (archive === undefined) {
      throw new Error("npm pack did not report a tarball filename");
    }
    await execa("tar", ["-xzf", resolve(scratch, archive), "-C", scratch]);

    const schema = JSON.parse(
      await readFile(
        resolve(scratch, "package/schema/zedbee.schema.json"),
        "utf8",
      ),
    );
    const validate = new Ajv({
      allErrors: true,
      strictTuples: false,
    }).compile(schema);
    expect(
      validate({
        schemaVersion: 1,
        reporting: {
          terminalFindingLimit: "all",
          temporaryReportMaxAge: "7d",
        },
      }),
      validate.errors?.map(String).join("\n"),
    ).toBe(true);
    expect(
      validate({
        schemaVersion: 1,
        reporting: { terminalFindingLimit: 0 },
      }),
    ).toBe(false);

    for (const checkId of ["cyclomaticComplexity", "readabilityComplexity"]) {
      const safe = {
        schemaVersion: 1,
        checks: { [checkId]: { max: Number.MAX_SAFE_INTEGER } },
      };
      const unsafe = {
        schemaVersion: 1,
        checks: { [checkId]: { max: Number.MAX_SAFE_INTEGER + 1 } },
      };

      expect(configFileSchema.safeParse(safe).success).toBe(true);
      expect(validate(safe), validate.errors?.map(String).join("\n")).toBe(
        true,
      );
      expect(configFileSchema.safeParse(unsafe).success).toBe(false);
      expect(validate(unsafe)).toBe(false);
    }

    for (const [checkId, field] of [
      ["formatting", "printWidth"],
      ["formatting", "tabWidth"],
      ["duplication", "minLines"],
      ["duplication", "minTokens"],
    ] as const) {
      const safe = {
        schemaVersion: 1,
        checks: {
          [checkId]: {
            settings: { [field]: Number.MAX_SAFE_INTEGER },
          },
        },
      };
      const unsafe = {
        schemaVersion: 1,
        checks: {
          [checkId]: {
            settings: { [field]: Number.MAX_SAFE_INTEGER + 1 },
          },
        },
      };

      expect(configFileSchema.safeParse(safe).success).toBe(true);
      expect(validate(safe), validate.errors?.map(String).join("\n")).toBe(
        true,
      );
      expect(configFileSchema.safeParse(unsafe).success).toBe(false);
      expect(validate(unsafe)).toBe(false);
    }
  });
});
