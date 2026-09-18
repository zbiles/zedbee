import { describe, expect, it } from "vitest";
import {
  parseProjectReply,
  parseProjectRequest,
} from "../../../src/checks/prettier/project-protocol.js";

describe("project Prettier protocol", () => {
  it("accepts a bounded format request", () => {
    expect(
      parseProjectRequest({
        id: 1,
        operation: "format",
        file: "src/value.ts",
        source: "export const value = 1;\n",
      }),
    ).toEqual({
      id: 1,
      operation: "format",
      file: "src/value.ts",
      source: "export const value = 1;\n",
    });
  });

  it("rejects extra fields and non-integer ids", () => {
    expect(() =>
      parseProjectRequest({
        id: 1,
        operation: "format",
        file: "value.ts",
        source: "",
        executable: "/bin/sh",
      }),
    ).toThrow();
    expect(() =>
      parseProjectRequest({
        id: 1.5,
        operation: "format",
        file: "value.ts",
        source: "",
      }),
    ).toThrow();
    expect(() =>
      parseProjectRequest({
        id: -1,
        operation: "format",
        file: "value.ts",
        source: "",
      }),
    ).toThrow();
  });

  it("rejects a format request that tries to supply a settings object", () => {
    expect(() =>
      parseProjectRequest({
        id: 2,
        operation: "format",
        file: "value.ts",
        source: "",
        settings: { singleQuote: true },
      }),
    ).toThrow();
  });

  it("rejects a forged reply with another check's result", () => {
    expect(() =>
      parseProjectReply(
        {
          id: 3,
          operation: "format",
          result: { kind: "formatted", text: "x" },
          checks: { lint: "pass" },
        },
        3,
      ),
    ).toThrow();
  });

  it("rejects replies that do not match the outstanding id", () => {
    expect(() =>
      parseProjectReply(
        { id: 4, operation: "format", result: { kind: "ignored", reason: "unsupported" } },
        5,
      ),
    ).toThrow();
  });

  it("rejects an unknown ignore reason", () => {
    expect(() =>
      parseProjectReply(
        { id: 6, operation: "format", result: { kind: "ignored", reason: "mystery" } },
        6,
      ),
    ).toThrow();
  });
});
