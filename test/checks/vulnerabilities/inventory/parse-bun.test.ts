import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseBunLockfile } from "../../../../src/checks/vulnerabilities/inventory/parse-bun.js";
import { parseLockfileInventory } from "../../../../src/checks/vulnerabilities/inventory/parse-lockfile.js";
import { inspectRepository } from "../../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../../inspection/fixture.js";

const root = fileURLToPath(new URL("../../../fixtures/lockfiles/bun/", import.meta.url));
const fixture = (name: string) => readFile(`${root}${name}`, "utf8");

describe("parseBunLockfile", () => {
  it("parses Bun 1.2 JSONC package tuples and excludes workspace locators", async () => {
    const records = parseBunLockfile(await fixture("bun-v1.2.lock"), "bun.lock");
    expect(records).toMatchObject([
      { name: "@scope/actual", version: "4.2.0" },
      { name: "@scope/direct", version: "3.1.0" },
      { name: "alpha", version: "1.0.2" },
      { name: "shared", version: "1.5.0", dependencyPath: ["alpha", "shared"] },
    ]);
    expect(records.some(({ name }) => name === "local-workspace")).toBe(false);
  });

  it("rejects unknown text versions and legacy binary lockfiles actionably", async () => {
    expect(() => parseBunLockfile('{"lockfileVersion":2,"packages":{}}', "bun.lock")).toThrowError(
      expect.objectContaining({ code: "LOCKFILE_VERSION_UNSUPPORTED" }),
    );

    const repository = await createInspectionFixture();
    await repository.writeJson("package.json", { packageManager: "bun@1.1.0" });
    await repository.write("bun.lockb", await fixture("bun.lockb"));
    const inspection = await inspectRepository(repository.root);
    await expect(parseLockfileInventory(inspection, "bun.lockb")).rejects.toMatchObject({
      code: "LOCKFILE_UNSUPPORTED_BINARY",
      remediation: "Run bun install --save-text-lockfile --frozen-lockfile --lockfile-only, then remove bun.lockb.",
    });
  });
});
