import { describe, expect, it, vi } from "vitest";
import { parseBunLockfile } from "../../../../src/checks/vulnerabilities/inventory/parse-bun.js";
import { parseYarnLockfile } from "../../../../src/checks/vulnerabilities/inventory/parse-yarn.js";

const work = vi.hoisted(() => ({ yarnKeyReads: 0, bunKeyReads: 0 }));

// Keep the real parser trees and conversion routines, and count source-key reads
// rather than elapsed time. Repeated searches then show up deterministically.
vi.mock("yaml", async (importOriginal) => {
  const actual = await importOriginal<typeof import("yaml")>();
  return {
    ...actual,
    parseDocument: (...args: Parameters<typeof actual.parseDocument>) => {
      const document = actual.parseDocument(...args);
      if (actual.isMap(document.contents)) {
        for (const pair of document.contents.items) {
          if (!actual.isScalar(pair.key)) continue;
          const value = pair.key.value;
          Object.defineProperty(pair.key, "value", {
            get() {
              work.yarnKeyReads += 1;
              return value;
            },
          });
        }
      }
      return document;
    },
  };
});

vi.mock("jsonc-parser", async (importOriginal) => {
  const actual = await importOriginal<typeof import("jsonc-parser")>();
  return {
    ...actual,
    parseTree: (...args: Parameters<typeof actual.parseTree>) => {
      const root = actual.parseTree(...args);
      const packages = root?.children?.find(
        (property) => property.children?.[0]?.value === "packages",
      )?.children?.[1];
      for (const property of packages?.children ?? []) {
        const key = property.children?.[0];
        if (key === undefined) continue;
        const value: unknown = key.value;
        Object.defineProperty(key, "value", {
          get() {
            work.bunKeyReads += 1;
            return value;
          },
        });
      }
      return root;
    },
  };
});

describe("lockfile provenance scaling", () => {
  it("reads Yarn source keys linearly as the inventory grows", () => {
    const counts = [100, 1_000].map((size) => {
      const contents = "__metadata:\n  version: 8\n" + Array.from(
        { length: size },
        (_, index) => `"pkg-${index}@npm:^1":\n  version: 1.0.0\n  resolution: "pkg-${index}@npm:1.0.0"\n`,
      ).join("");
      work.yarnKeyReads = 0;
      const records = parseYarnLockfile(contents, "yarn.lock");
      expect(records).toHaveLength(size);
      expect(records.find(({ name }) => name === `pkg-${size - 1}`)?.line).toBe(size * 3);
      expect(work.yarnKeyReads).toBeGreaterThanOrEqual(size);
      expect(work.yarnKeyReads).toBeLessThan(size * 10);
      return work.yarnKeyReads;
    });
    expect(counts[1]).toBeLessThan(counts[0]! * 12);
  });

  it("reads Bun source keys linearly as the inventory grows", () => {
    const counts = [100, 1_000].map((size) => {
      const contents = '{"lockfileVersion":1,"packages":{\n' + Array.from(
        { length: size },
        (_, index) => `"pkg-${index}":["pkg-${index}@1.0.0"]`,
      ).join(",\n") + "\n}}";
      work.bunKeyReads = 0;
      const records = parseBunLockfile(contents, "bun.lock");
      expect(records).toHaveLength(size);
      expect(records.find(({ name }) => name === `pkg-${size - 1}`)?.line).toBe(size + 1);
      expect(work.bunKeyReads).toBeGreaterThanOrEqual(size);
      expect(work.bunKeyReads).toBeLessThan(size * 10);
      return work.bunKeyReads;
    });
    expect(counts[1]).toBeLessThan(counts[0]! * 12);
  });
});
