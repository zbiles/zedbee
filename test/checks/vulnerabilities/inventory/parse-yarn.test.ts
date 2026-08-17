import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseYarnLockfile } from "../../../../src/checks/vulnerabilities/inventory/parse-yarn.js";

const root = fileURLToPath(new URL("../../../fixtures/lockfiles/yarn/", import.meta.url));
const fixture = (name: string) => readFile(`${root}${name}`, "utf8");

describe("parseYarnLockfile", () => {
  it("uses Yarn Classic semantics and a validated stanza line index", async () => {
    const records = parseYarnLockfile(await fixture("yarn-classic-v1.lock"), "yarn.lock");
    expect(records).toMatchObject([
      { name: "@scope/actual", version: "4.2.0" },
      { name: "@scope/direct", version: "3.1.0" },
      { name: "alpha", version: "1.0.2", line: 3 },
      { name: "optional-child", version: "2.1.0" },
      { name: "shared", version: "1.5.0" },
    ]);
  });

  it("parses Yarn Modern YAML resolution names and excludes workspaces", async () => {
    const records = parseYarnLockfile(await fixture("yarn-modern.lock"), "yarn.lock");
    expect(records).toMatchObject([
      { name: "@scope/actual", version: "4.2.0" },
      { name: "@scope/direct", version: "3.1.0" },
      { name: "alpha", version: "1.0.2", line: 5 },
      { name: "shared", version: "1.5.0" },
    ]);
    expect(records.some(({ name }) => name === "workspace-only")).toBe(false);
  });

  it("rejects malformed classic and modern lockfiles", () => {
    expect(() => parseYarnLockfile("# yarn lockfile v1\nalpha@^1:\n", "yarn.lock")).toThrowError(
      expect.objectContaining({ code: "LOCKFILE_VERSION_MISSING" }),
    );
    expect(() => parseYarnLockfile("__metadata:\n  version: 99\n", "yarn.lock")).toThrowError(
      expect.objectContaining({ code: "LOCKFILE_VERSION_UNSUPPORTED" }),
    );
  });
});
