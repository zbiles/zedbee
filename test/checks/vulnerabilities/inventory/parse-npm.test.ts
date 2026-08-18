import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseNpmLockfile } from "../../../../src/checks/vulnerabilities/inventory/parse-npm.js";
import { parseLockfileInventory } from "../../../../src/checks/vulnerabilities/inventory/parse-lockfile.js";
import { LockfileInventoryError } from "../../../../src/checks/vulnerabilities/inventory/errors.js";
import {
  MAX_DEPENDENCY_RECORDS,
  MAX_LOCKFILE_BYTES,
  MAX_LOCKFILE_NESTING,
  MAX_PACKAGE_NAME_LENGTH,
} from "../../../../src/checks/vulnerabilities/inventory/limits.js";
import { inspectRepository } from "../../../../src/inspection/inspect-repository.js";
import { createInspectionFixture } from "../../../inspection/fixture.js";

const fixtureRoot = fileURLToPath(
  new URL("../../../fixtures/lockfiles/npm/", import.meta.url),
);

async function fixture(name: string): Promise<string> {
  return readFile(`${fixtureRoot}${name}`, "utf8");
}

function compact(records: ReturnType<typeof parseNpmLockfile>) {
  return records.map(
    ({ name, version, lockfilePath, line, dependencyPath }) => ({
      name,
      version,
      lockfilePath,
      line,
      dependencyPath,
    }),
  );
}

describe("parseNpmLockfile", () => {
  it("normalizes npm v1 nested, scoped, optional, and transitive packages", async () => {
    const records = parseNpmLockfile(
      await fixture("package-lock-v1.json"),
      "package-lock.json",
    );

    expect(compact(records)).toEqual([
      {
        name: "@scope/direct",
        version: "3.1.0",
        lockfilePath: "package-lock.json",
        line: 13,
        dependencyPath: ["@scope/direct"],
      },
      {
        name: "alpha",
        version: "1.0.0",
        lockfilePath: "package-lock.json",
        line: 6,
        dependencyPath: ["alpha"],
      },
      {
        name: "nested",
        version: "2.0.0",
        lockfilePath: "package-lock.json",
        line: 9,
        dependencyPath: ["alpha", "nested"],
      },
    ]);
    expect(Object.isFrozen(records)).toBe(true);
    expect(records.every(Object.isFrozen)).toBe(true);
  });

  it("normalizes npm v2 packages and excludes roots and workspace links", async () => {
    expect(
      compact(
        parseNpmLockfile(
          await fixture("package-lock-v2.json"),
          "package-lock.json",
        ),
      ),
    ).toEqual([
      expect.objectContaining({
        name: "@scope/direct",
        version: "3.1.0",
        dependencyPath: ["@scope/direct"],
      }),
      expect.objectContaining({
        name: "alpha",
        version: "1.0.0",
        dependencyPath: ["alpha"],
      }),
      expect.objectContaining({
        name: "nested",
        version: "2.0.0",
        dependencyPath: ["alpha", "nested"],
      }),
    ]);
  });

  it("retains duplicate package versions when dependency paths differ", async () => {
    const records = parseNpmLockfile(
      await fixture("package-lock-v3.json"),
      "package-lock.json",
    );
    expect(records.filter(({ name }) => name === "shared")).toMatchObject([
      { version: "1.5.0", dependencyPath: ["alpha", "shared"] },
      { version: "2.5.0", dependencyPath: ["beta", "shared"] },
    ]);
  });

  it("accepts npm shrinkwrap with the same contract", async () => {
    expect(
      parseNpmLockfile(
        await fixture("npm-shrinkwrap-v3.json"),
        "npm-shrinkwrap.json",
      ),
    ).toMatchObject([
      {
        name: "production-only",
        version: "4.2.0",
        ecosystem: "npm",
        lockfilePath: "npm-shrinkwrap.json",
      },
    ]);
  });

  it("sorts records deterministically regardless of package property order", () => {
    const contents = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/zeta": { version: "1.0.0" },
        "node_modules/alpha": { version: "2.0.0" },
      },
    });
    expect(
      parseNpmLockfile(contents, "package-lock.json").map((r) => r.name),
    ).toEqual(["alpha", "zeta"]);
  });

  it("ignores unresolved optional platform placeholders without versions", () => {
    const contents = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "node_modules/native-engine": { version: "1.0.0" },
        "node_modules/native-engine/node_modules/native-engine-linux-x64": {
          optional: true,
        },
      },
    });

    expect(compact(parseNpmLockfile(contents, "package-lock.json"))).toEqual([
      expect.objectContaining({ name: "native-engine", version: "1.0.0" }),
    ]);
  });

  it.each([
    ["invalid JSON", "{", "LOCKFILE_INVALID"],
    [
      "an unknown format version",
      JSON.stringify({ lockfileVersion: 4, packages: {} }),
      "LOCKFILE_VERSION_UNSUPPORTED",
    ],
    [
      "a missing exact version",
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/alpha": {} },
      }),
      "LOCKFILE_VERSION_MISSING",
    ],
    [
      "a version range",
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "node_modules/alpha": { version: "^1.0.0" } },
      }),
      "LOCKFILE_VERSION_INVALID",
    ],
    [
      "an unsafe package path",
      JSON.stringify({
        lockfileVersion: 3,
        packages: { "../node_modules/alpha": { version: "1.0.0" } },
      }),
      "LOCKFILE_INVALID",
    ],
  ] as const)(
    "rejects %s without returning a partial inventory",
    (_label, input, code) => {
      expect(() => parseNpmLockfile(input, "package-lock.json")).toThrowError(
        expect.objectContaining({ code }),
      );
    },
  );

  it("rejects unsafe lockfile paths", async () => {
    const contents = await fixture("package-lock-v3.json");
    expect(() =>
      parseNpmLockfile(contents, "../package-lock.json"),
    ).toThrowError(LockfileInventoryError);
  });

  it("enforces byte, record, nesting, and package-name limits", () => {
    expect(() =>
      parseNpmLockfile(" ".repeat(MAX_LOCKFILE_BYTES + 1), "package-lock.json"),
    ).toThrowError(
      expect.objectContaining({ code: "LOCKFILE_LIMIT_EXCEEDED" }),
    );

    const packages = Object.fromEntries(
      Array.from({ length: MAX_DEPENDENCY_RECORDS + 1 }, (_, index) => [
        `node_modules/package-${index}`,
        { version: "1.0.0" },
      ]),
    );
    expect(() =>
      parseNpmLockfile(
        JSON.stringify({ lockfileVersion: 3, packages }),
        "package-lock.json",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "LOCKFILE_LIMIT_EXCEEDED" }),
    );

    const nested = `${'{"value":'.repeat(MAX_LOCKFILE_NESTING + 1)}null${"}".repeat(MAX_LOCKFILE_NESTING + 1)}`;
    expect(() => parseNpmLockfile(nested, "package-lock.json")).toThrowError(
      expect.objectContaining({ code: "LOCKFILE_LIMIT_EXCEEDED" }),
    );

    const longName = "a".repeat(MAX_PACKAGE_NAME_LENGTH + 1);
    expect(() =>
      parseNpmLockfile(
        JSON.stringify({
          lockfileVersion: 3,
          packages: { [`node_modules/${longName}`]: { version: "1.0.0" } },
        }),
        "package-lock.json",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "LOCKFILE_LIMIT_EXCEEDED" }),
    );
  });
});

describe("parseLockfileInventory", () => {
  it("reads only lockfiles discovered inside the inspected snapshot", async () => {
    const repository = await createInspectionFixture();
    await repository.writeJson("package.json", { name: "fixture" });
    await repository.write(
      "package-lock.json",
      await fixture("package-lock-v3.json"),
    );
    await repository.write(
      "not-discovered.json",
      await fixture("package-lock-v3.json"),
    );
    const inspection = await inspectRepository(repository.root);

    await expect(
      parseLockfileInventory(inspection, "package-lock.json"),
    ).resolves.toHaveLength(4);
    await expect(
      parseLockfileInventory(inspection, "not-discovered.json"),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "LOCKFILE_NOT_DISCOVERED" }),
    );
    await expect(
      parseLockfileInventory(inspection, "/tmp/package-lock.json"),
    ).rejects.toThrowError(
      expect.objectContaining({ code: "LOCKFILE_NOT_DISCOVERED" }),
    );
  });

  it("reports an oversized snapshot lockfile as a safety-limit failure", async () => {
    const repository = await createInspectionFixture();
    await repository.writeJson("package.json", { name: "fixture" });
    await repository.write(
      "package-lock.json",
      " ".repeat(MAX_LOCKFILE_BYTES + 1),
    );
    const inspection = await inspectRepository(repository.root);

    await expect(
      parseLockfileInventory(inspection, "package-lock.json"),
    ).rejects.toMatchObject({ code: "LOCKFILE_LIMIT_EXCEEDED" });
  });
});
