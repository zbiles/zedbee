import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MAX_DEPENDENCY_RECORDS } from "../../../../src/checks/vulnerabilities/inventory/limits.js";
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

  it("preserves Modern alias and combined-descriptor source lines across skipped workspaces", () => {
    const contents = [
      "# lockfile",
      "__metadata:",
      "  version: 8",
      '"local@workspace:.":',
      '  resolution: "local@workspace:."',
      '"alias@npm:@scope/actual@^1, alias@npm:@scope/actual@~1":',
      "  version: 1.0.0",
      '  resolution: "@scope/actual@npm:1.0.0"',
      '"duplicate@npm:^1":',
      "  version: 1.0.0",
      '  resolution: "@scope/actual@npm:1.0.0"',
      '"alpha@npm:^2":',
      "  version: 2.0.0",
      '  resolution: "alpha@npm:2.0.0"',
    ].join("\r\n");
    expect(parseYarnLockfile(contents, "yarn.lock")).toMatchObject([
      { name: "@scope/actual", version: "1.0.0", line: 6 },
      { name: "alpha", version: "2.0.0", line: 12 },
    ]);
  });

  it.each(["classic", "modern"])("bounds %s records before validating the remaining entries", (format) => {
    const entries = Array.from({ length: MAX_DEPENDENCY_RECORDS + 1 }, (_, index) =>
      format === "classic"
        ? `"alias-${index}@npm:actual@^1":\n  version "1.0.0"\n`
        : `"alias-${index}@npm:actual@^1":\n  version: 1.0.0\n  resolution: "actual@npm:1.0.0"\n`,
    );
    const header = format === "classic" ? "# yarn lockfile v1\n\n" : "__metadata:\n  version: 8\n\n";
    const workspace = format === "classic" ? "" : '"local@workspace:.":\n  resolution: "local@workspace:."\n';
    // The raw-record cap precedes deduplication; metadata and workspaces do not count.
    expect(parseYarnLockfile(header + entries.slice(0, MAX_DEPENDENCY_RECORDS).join("\n") + workspace, "yarn.lock")).toHaveLength(1);
    const invalidTail = format === "classic" ? '"invalid@^1":\n' : '"invalid@npm:^1": {}\n';
    expect(() => parseYarnLockfile(header + entries.join("\n") + invalidTail, "yarn.lock")).toThrowError(
      expect.objectContaining({ code: "LOCKFILE_LIMIT_EXCEEDED" }),
    );
  });
});
