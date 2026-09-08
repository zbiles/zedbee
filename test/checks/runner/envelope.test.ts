import { describe, expect, it } from "vitest";
import { analyzerRequestRetentionBytes } from "../../../src/checks/runner/envelope.js";
import { createLocalAnalyzerExecutor } from "../../../src/checks/runner/executor.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../../src/checks/prettier/settings.js";

describe("request admission data boundary", () => {
  it("still accepts an ordinary plain-data formatting request", async () => {
    const executor = createLocalAnalyzerExecutor();
    const session = await executor.openSession();
    try {
      expect(
        await session.run({
          version: 1,
          checkId: "formatting",
          operation: "format-working-source",
          input: {
            file: "a.js",
            source: "const value=1",
            settings: DEFAULT_FORMATTING_SETTINGS,
          },
        }),
      ).toBe("const value = 1;\n");
    } finally {
      await executor.close();
    }
  });
  it("rejects a changing source accessor before invoking it", async () => {
    let reads = 0;
    const executor = createLocalAnalyzerExecutor();
    const session = await executor.openSession();
    const request = {
      version: 1 as const,
      checkId: "formatting" as const,
      operation: "format-working-source" as const,
      input: {
        file: "a.js",
        get source() {
          return ++reads === 1 ? "a" : "a".repeat(4096);
        },
        settings: DEFAULT_FORMATTING_SETTINGS,
      },
    };
    try {
      await expect(session.run(request)).rejects.toThrow(
        "Invalid analyzer request",
      );
      expect(reads).toBe(0);
    } finally {
      await executor.close();
    }
  });

  it.each(["nested object", "array element"])(
    "rejects %s accessors without invoking them",
    (kind) => {
      let reads = 0;
      const nested = kind === "array element" ? [] : {};
      Object.defineProperty(nested, kind === "array element" ? "0" : "source", {
        enumerable: true,
        get() {
          reads++;
          return "source";
        },
      });
      expect(() => analyzerRequestRetentionBytes({ nested })).toThrow();
      expect(reads).toBe(0);
    },
  );

  it.each([false, true])(
    "rejects proxies before their traps (nested=%s)",
    (nested) => {
      let traps = 0;
      const proxy = new Proxy(
        {},
        {
          get() {
            traps++;
            return undefined;
          },
          ownKeys() {
            traps++;
            return [];
          },
          getOwnPropertyDescriptor() {
            traps++;
            return undefined;
          },
          getPrototypeOf() {
            traps++;
            return Object.prototype;
          },
        },
      );
      expect(() =>
        analyzerRequestRetentionBytes(nested ? { proxy } : proxy),
      ).toThrow();
      expect(traps).toBe(0);
    },
  );

  it("charges ordinary detached plain data consistently", () => {
    const input = {
      source: "a".repeat(4096),
      nested: [{ enabled: true }, null],
    };
    expect(analyzerRequestRetentionBytes(input)).toBe(
      analyzerRequestRetentionBytes(structuredClone(input)),
    );
  });

  it("does not invoke custom binary accessors and charges the full backing store", () => {
    let reads = 0;
    const buffer = new ArrayBuffer(4096);
    const view = new Uint8Array(buffer, 0, 1);
    Object.defineProperty(view, "byteLength", {
      get() {
        reads++;
        return 1;
      },
    });
    Object.defineProperty(view, "buffer", {
      get() {
        reads++;
        return buffer;
      },
    });
    expect(analyzerRequestRetentionBytes(view)).toBeGreaterThanOrEqual(4096);
    expect(reads).toBe(0);
  });
});
