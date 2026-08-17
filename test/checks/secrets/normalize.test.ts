import { describe, expect, it } from "vitest";
import { normalizeSecretlintMessages } from "../../../src/checks/secrets/normalize.js";

describe("normalizeSecretlintMessages", () => {
  it("retains only safe rule/location metadata and a keyed comparison digest", () => {
    const canary = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const result = normalizeSecretlintMessages({
      messages: [
        {
          type: "message",
          ruleId: "@secretlint/secretlint-rule-github",
          message: `found token ${canary}`,
          messageId: "GITHUB_TOKEN",
          range: [0, canary.length],
          loc: {
            start: { line: 4, column: 2 },
            end: { line: 4, column: canary.length + 2 },
          },
          severity: "error",
        },
      ],
      source: canary,
      reportPath: "src/credentials.ts",
      identityPath: "src/credentials.ts",
      comparisonKey: new Uint8Array(32).fill(7),
    });

    expect(result).toMatchObject([
      {
        check: "secrets",
        rule: "@secretlint/secretlint-rule-github",
        severity: "error",
        location: {
          file: "src/credentials.ts",
          startLine: 4,
          startColumn: 3,
          endLine: 4,
          endColumn: canary.length + 3,
        },
      },
    ]);
    expect(JSON.stringify(result)).not.toContain(canary);
    expect(JSON.stringify(result)).not.toContain("found token");
  });

  it("rejects invalid ranges without reflecting source content", () => {
    const canary = "private-secret-canary";
    expect(() =>
      normalizeSecretlintMessages({
        messages: [
          {
            type: "message",
            ruleId: "test",
            message: canary,
            messageId: "test",
            range: [0, 999],
            loc: { start: { line: 1, column: 0 }, end: { line: 1, column: 999 } },
            severity: "error",
          },
        ],
        source: canary,
        reportPath: "src/value.txt",
        identityPath: "src/value.txt",
        comparisonKey: new Uint8Array(32),
      }),
    ).toThrow("Secretlint returned an invalid result");
  });
});
