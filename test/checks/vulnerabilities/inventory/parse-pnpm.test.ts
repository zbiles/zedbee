import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePnpmLockfile } from "../../../../src/checks/vulnerabilities/inventory/parse-pnpm.js";

const root = fileURLToPath(
  new URL("../../../fixtures/lockfiles/pnpm/", import.meta.url),
);
const fixture = (name: string) => readFile(`${root}${name}`, "utf8");

describe("parsePnpmLockfile", () => {
  it("parses format 6 package, peer, optional, alias, and transitive records", async () => {
    const records = parsePnpmLockfile(
      await fixture("pnpm-lock-v6.yaml"),
      "pnpm-lock.yaml",
    );
    expect(records).toMatchObject([
      { name: "@scope/actual", version: "3.1.0" },
      { name: "alpha", version: "1.0.0" },
      { name: "peerful", version: "2.0.0" },
      { name: "shared", version: "1.5.0" },
    ]);
    expect(records.find(({ name }) => name === "alpha")?.line).toBe(13);
  });

  it("parses format 9 importers, duplicate versions, and peer snapshots", async () => {
    const records = parsePnpmLockfile(
      await fixture("pnpm-lock-v9.yaml"),
      "pnpm-lock.yaml",
    );
    expect(
      records
        .filter(({ name }) => name === "shared")
        .map(({ version }) => version),
    ).toEqual(["1.5.0", "2.5.0"]);
    expect(records.find(({ name }) => name === "alpha")).toMatchObject({
      importer: ".",
      dependencyPath: ["alpha"],
    });
    expect(records.some(({ name }) => name === "local-workspace")).toBe(false);
    expect(
      records.some(
        ({ name, version }) => name === "peerful" && version === "2.0.0",
      ),
    ).toBe(true);
  });

  it("matches pnpm 9 npm: aliases to their real package", () => {
    const records = parsePnpmLockfile(
      "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      string-width-cjs:\n        specifier: npm:string-width@^4.2.0\n        version: string-width@4.2.3\npackages:\n  string-width@4.2.3:\n    resolution: {integrity: sha512-x}\n",
      "pnpm-lock.yaml",
    );
    expect(records).toMatchObject([
      {
        name: "string-width",
        version: "4.2.3",
        importer: ".",
        dependencyPath: ["string-width-cjs"],
      },
    ]);
  });

  it("rejects unsupported versions and ambiguous package keys", () => {
    expect(() =>
      parsePnpmLockfile(
        "lockfileVersion: '10.0'\npackages: {}\n",
        "pnpm-lock.yaml",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "LOCKFILE_VERSION_UNSUPPORTED" }),
    );
    expect(() =>
      parsePnpmLockfile(
        "lockfileVersion: '9.0'\npackages:\n  not-exact: {}\n",
        "pnpm-lock.yaml",
      ),
    ).toThrowError(
      expect.objectContaining({ code: "LOCKFILE_VERSION_MISSING" }),
    );
  });
});
