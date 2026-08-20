import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { Ajv } from "ajv";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

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
    const validate = new Ajv({ allErrors: true }).compile(schema);
    expect(
      validate({
        schemaVersion: 1,
        reporting: {
          terminalFindingLimit: "all",
          temporaryReportRetention: 9,
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
  });
});
