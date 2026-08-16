import { describe, expect, it } from "vitest";
import { parseAndRedactGitleaksReport } from "../../../src/checks/secrets/redact.js";

describe("parseAndRedactGitleaksReport", () => {
  it("retains only location and rule metadata", () => {
    const canary = "zedbee_test_secret_do_not_expose";
    const raw = JSON.stringify([
      {
        RuleID: "generic-api-key",
        File: "src/credentials.ts",
        StartLine: 4,
        EndLine: 4,
        StartColumn: 18,
        EndColumn: 55,
        Secret: canary,
        Match: `token = ${canary}`,
        Commit: "0123456789",
        Author: "Test Author",
        Email: "author@example.test",
        Message: `add ${canary}`,
        Fingerprint: `0123456789:src/credentials.ts:generic-api-key:4:${canary}`,
        Entropy: 7.8,
      },
    ]);

    const result = parseAndRedactGitleaksReport(raw);

    expect(result).toEqual([
      {
        ruleId: "generic-api-key",
        file: "src/credentials.ts",
        startLine: 4,
        endLine: 4,
        startColumn: 18,
        endColumn: 55,
      },
    ]);
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(canary);
    expect(serialized).not.toContain("author@example.test");
    expect(serialized).not.toContain("0123456789");
  });

  it("rejects malformed reports without reflecting secret-bearing input", () => {
    const canary = "zedbee_malformed_secret_do_not_expose";

    expect(() =>
      parseAndRedactGitleaksReport(
        JSON.stringify([{ RuleID: "test", Secret: canary }]),
      ),
    ).toThrow("Gitleaks returned an invalid report");

    try {
      parseAndRedactGitleaksReport(
        JSON.stringify([{ RuleID: "test", Secret: canary }]),
      );
    } catch (error) {
      expect(JSON.stringify(error)).not.toContain(canary);
      expect(String(error)).not.toContain(canary);
    }
  });

  it("rejects non-array and non-JSON output with one generic error", () => {
    expect(() => parseAndRedactGitleaksReport("not-json")).toThrow(
      "Gitleaks returned an invalid report",
    );
    expect(() => parseAndRedactGitleaksReport("{}")).toThrow(
      "Gitleaks returned an invalid report",
    );
  });
});
