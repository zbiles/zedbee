import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_DEPENDENCY_RECORDS } from "../../../../src/checks/vulnerabilities/inventory/limits.js";
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

  it("attributes multiline alias tuples to their values and skips workspace and link entries", () => {
    const contents = [
      "{",
      '  "lockfileVersion": 1,',
      '  "packages": {',
      '    "local": ["local@workspace:packages/local"],',
      '    "linked": ["linked@link:../linked"],',
      '    "alias":',
      '      ["@scope/actual@1.0.0"],',
      '    "@scope/direct/child": ["child@2.0.0"],',
      '    "child": ["child@3.0.0"],',
      '    "child": ["child@4.0.0"],',
      "  },",
      "}",
    ].join("\r\n");
    expect(parseBunLockfile(contents, "bun.lock")).toMatchObject([
      { name: "@scope/actual", version: "1.0.0", line: 7, dependencyPath: ["alias"] },
      { name: "child", version: "2.0.0", line: 8, dependencyPath: ["@scope/direct", "child"] },
      { name: "child", version: "4.0.0", line: 9, dependencyPath: ["child"] },
    ]);
  });

  it("bounds records before validating the remaining tuples", () => {
    const entries = Array.from({ length: MAX_DEPENDENCY_RECORDS + 1 }, (_, index) =>
      `"pkg-${index}":["actual@1.0.0"]`,
    );
    const supported = '{"lockfileVersion":1,"packages":{' + entries.slice(0, MAX_DEPENDENCY_RECORDS).join(",") + ',"local":["local@workspace:."],"linked":["linked@link:../linked"]}}';
    expect(parseBunLockfile(supported, "bun.lock")).toHaveLength(MAX_DEPENDENCY_RECORDS);
    const contents = '{"lockfileVersion":1,"packages":{' + entries.join(",") + ',"invalid":[]}}';
    expect(() => parseBunLockfile(contents, "bun.lock")).toThrowError(
      expect.objectContaining({ code: "LOCKFILE_LIMIT_EXCEEDED" }),
    );
  });
});
