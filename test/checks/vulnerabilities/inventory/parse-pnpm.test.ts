import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parsePnpmLockfile } from "../../../../src/checks/vulnerabilities/inventory/parse-pnpm.js";

const root = fileURLToPath(new URL("../../../fixtures/lockfiles/pnpm/", import.meta.url));
const fixture = (name: string) => readFile(`${root}${name}`, "utf8");

describe("parsePnpmLockfile", () => {
  it("parses format 6 package, peer, optional, alias, and transitive records", async () => {
    const records = parsePnpmLockfile(await fixture("pnpm-lock-v6.yaml"), "pnpm-lock.yaml");
    expect(records).toMatchObject([
      { name: "@scope/actual", version: "3.1.0" },
      { name: "alpha", version: "1.0.0" },
      { name: "peerful", version: "2.0.0" },
      { name: "shared", version: "1.5.0" },
    ]);
    expect(records.find(({ name }) => name === "alpha")?.line).toBe(13);
  });

  it("parses format 9 importers, duplicate versions, and peer snapshots", async () => {
    const records = parsePnpmLockfile(await fixture("pnpm-lock-v9.yaml"), "pnpm-lock.yaml");
    expect(records.filter(({ name }) => name === "shared").map(({ version }) => version)).toEqual([
      "1.5.0",
      "2.5.0",
    ]);
    expect(records.find(({ name }) => name === "alpha")).toMatchObject({
      importer: ".",
      dependencyPath: ["alpha"],
    });
    expect(records.some(({ name }) => name === "local-workspace")).toBe(false);
    expect(records.some(({ name, version }) => name === "peerful" && version === "2.0.0")).toBe(true);
  });

  it("rejects unsupported versions and ambiguous package keys", () => {
    expect(() => parsePnpmLockfile("lockfileVersion: '10.0'\npackages: {}\n", "pnpm-lock.yaml")).toThrowError(
      expect.objectContaining({ code: "LOCKFILE_VERSION_UNSUPPORTED" }),
    );
    expect(() => parsePnpmLockfile("lockfileVersion: '9.0'\npackages:\n  not-exact: {}\n", "pnpm-lock.yaml")).toThrowError(
      expect.objectContaining({ code: "LOCKFILE_VERSION_MISSING" }),
    );
  });
});
