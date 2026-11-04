import { posix, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { validConfigPath } from "../../src/config/selection-path.js";

describe("selected config containment", () => {
  it("rejects Windows parent traversal, external absolute and cross-drive paths", () => {
    for (const requested of [
      "..\\outside.jsonc",
      "C:\\outside.jsonc",
      "D:\\config.jsonc",
      "..",
      ".",
    ]) {
      expect(validConfigPath("C:\\repo", requested, win32)).toBeUndefined();
    }
    expect(validConfigPath("C:\\repo", "config\\rules.jsonc", win32)).toBe(
      "C:\\repo\\config\\rules.jsonc",
    );
    expect(validConfigPath("C:\\repo", "C:\\repo\\rules.jsonc", win32)).toBe(
      "C:\\repo\\rules.jsonc",
    );
  });
  it("uses the same policy for POSIX paths and requires JSONC", () => {
    expect(validConfigPath("/repo", "../outside.jsonc", posix)).toBeUndefined();
    expect(validConfigPath("/repo", "rules.json", posix)).toBeUndefined();
    expect(validConfigPath("/repo", "config/rules.jsonc", posix)).toBe(
      "/repo/config/rules.jsonc",
    );
  });
});
