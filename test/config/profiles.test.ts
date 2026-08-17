import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/profiles.js";
import { CHECK_IDS, type CheckId } from "../../src/config/schema.js";

describe("managed check profiles", () => {
  it("publishes every managed check ID in stable order", () => {
    expect(CHECK_IDS).toEqual([
      "formatting",
      "lint",
      "types",
      "cyclomaticComplexity",
      "readabilityComplexity",
      "structuralSecurity",
      "secrets",
      "duplication",
      "dependencyArchitecture",
      "deadCode",
      "reactCorrectness",
      "reactAccessibility",
      "vulnerabilities",
    ]);
  });

  it.each([
    {
      profile: "fast" as const,
      enabled: [
        "formatting",
        "lint",
        "cyclomaticComplexity",
        "readabilityComplexity",
        "structuralSecurity",
        "reactCorrectness",
        "reactAccessibility",
      ],
      disabled: [
        "types",
        "secrets",
        "duplication",
        "dependencyArchitecture",
        "deadCode",
        "vulnerabilities",
      ],
    },
    {
      profile: "recommended" as const,
      enabled: [
        "formatting",
        "lint",
        "types",
        "cyclomaticComplexity",
        "readabilityComplexity",
        "structuralSecurity",
        "secrets",
        "reactCorrectness",
        "reactAccessibility",
      ],
      disabled: [
        "duplication",
        "dependencyArchitecture",
        "deadCode",
        "vulnerabilities",
      ],
    },
    {
      profile: "thorough" as const,
      enabled: [...CHECK_IDS],
      disabled: [],
    },
  ])(
    "resolves the $profile profile into complete policies",
    ({ profile, enabled, disabled }) => {
      const config = resolveConfig({ schemaVersion: 1, profile });

      expect(Object.keys(config.checks)).toEqual(CHECK_IDS);
      for (const checkId of enabled as readonly CheckId[]) {
        expect(config.checks[checkId]).toMatchObject({
          severity: "error",
          when: "relevant",
        });
      }
      for (const checkId of disabled as readonly CheckId[]) {
        expect(config.checks[checkId]).toMatchObject({
          severity: "off",
          when: "relevant",
        });
      }
    },
  );

  it("merges root check fields over complete profile defaults", () => {
    const config = resolveConfig({
      schemaVersion: 1,
      profile: "fast",
      checks: {
        duplication: { severity: "warn", threshold: 5 },
        cyclomaticComplexity: { max: 20, blockWorsening: true },
        vulnerabilities: { onUnavailable: "warn" },
      },
    });

    expect(config.checks.duplication).toEqual({
      severity: "warn",
      when: "relevant",
      threshold: 5,
    });
    expect(config.checks.cyclomaticComplexity).toEqual({
      severity: "error",
      when: "relevant",
      max: 20,
      blockWorsening: true,
    });
    expect(config.checks.vulnerabilities).toEqual({
      severity: "off",
      when: "relevant",
      onUnavailable: "warn",
    });
  });

  it("defaults online vulnerability availability failures to blocking", () => {
    const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });

    expect(config.checks.vulnerabilities).toEqual({
      severity: "error",
      when: "relevant",
      onUnavailable: "block",
    });
  });

  it("supplies executable managed complexity defaults", () => {
    const config = resolveConfig({ schemaVersion: 1, profile: "recommended" });

    expect(config.checks.cyclomaticComplexity).toMatchObject({
      max: 20,
      blockWorsening: true,
    });
    expect(config.checks.readabilityComplexity).toMatchObject({
      max: 15,
      blockWorsening: true,
    });
    expect(config.checks.duplication).toMatchObject({ threshold: 5 });
  });
});
