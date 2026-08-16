import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
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
  it("includes the checked-in schema in the npm tarball", async () => {
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
      files: Array<{ path: string }>;
    }>;
    expect(metadata[0]?.files.map(({ path }) => path)).toContain(
      "schema/zedbee.schema.json",
    );
  });
});
