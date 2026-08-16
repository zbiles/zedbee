import { describe, expect, it } from "vitest";
import { compareObservationSets } from "../../src/attribution/compare.js";
import { fingerprintObservation } from "../../src/attribution/fingerprint.js";
import { createObservation } from "../helpers/scan-report.js";

const target = createObservation({
  check: "types",
  rule: "TS2322",
  identity: "typescript:TS2322",
  message: "Type 'string' is not assignable to type 'number'.",
  location: { file: "src/value.ts", startLine: 2, startColumn: 7 },
});

const noChangeEvidence = {
  changedPaths: [],
  changedEntityIdentities: [],
  repositoryDelta: false,
} as const;

describe("compareObservationSets", () => {
  it("attributes a file-scoped target-only observation with no precise line when a changed path proves relevance", () => {
    const pathOnly = createObservation({
      ...target,
      location: { file: "src/value.ts" },
    });
    const findings = compareObservationSets([], [pathOnly], {
      changedPaths: ["src/value.ts"],
      changedEntityIdentities: [],
      repositoryDelta: false,
    });

    expect(findings[0]?.attribution).toMatchObject({
      kind: "baseline-comparison",
      staged: true,
    });
    expect(findings[0]?.attribution.evidence).toEqual([
      "changed-path:src/value.ts",
      `target-only:${findings[0]?.id}`,
    ]);
  });

  it("does not use changed-path fallback for a precise finding outside added ranges", () => {
    const findings = compareObservationSets([], [target], {
      changedPaths: ["src/value.ts"],
      changedEntityIdentities: [],
      repositoryDelta: false,
      addedRanges: [{ file: "src/value.ts", start: 8, end: 9 }],
    });

    expect(findings[0]?.attribution).toEqual({
      kind: "none",
      staged: false,
      evidence: [],
    });
  });

  it("leaves an equal baseline observation unattributed despite changed-path evidence", () => {
    const findings = compareObservationSets([target], [target], {
      ...noChangeEvidence,
      changedPaths: ["src/value.ts"],
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.attribution).toEqual({
      kind: "none",
      staged: false,
      evidence: [],
    });
  });

  it("uses an ephemeral comparison identity without changing the public finding id", () => {
    const baseline = { ...target, comparisonIdentity: "baseline-value" };
    const replacement = { ...target, comparisonIdentity: "target-value" };
    const [finding] = compareObservationSets([baseline], [replacement], {
      ...noChangeEvidence,
      changedPaths: ["src/value.ts"],
      addedRanges: [{ file: "src/value.ts", start: 2, end: 2 }],
    });

    expect(finding?.id).toBe(fingerprintObservation(target));
    expect(finding?.attribution.staged).toBe(true);
    expect(JSON.stringify(finding)).not.toContain("target-value");
  });

  it("requires changed entity evidence for an entity-scoped target-only finding", () => {
    const entityTarget = createObservation({
      identity: "function:src/parser.ts:parseOrder",
      location: undefined,
      entity: { kind: "function", name: "parseOrder", file: "src/parser.ts" },
    });

    const unrelated = compareObservationSets([], [entityTarget], {
      ...noChangeEvidence,
      changedPaths: ["src/parser.ts"],
    });
    const changed = compareObservationSets([], [entityTarget], {
      ...noChangeEvidence,
      changedEntityIdentities: ["function:src/parser.ts:parseOrder"],
    });

    expect(unrelated[0]?.attribution).toEqual({
      kind: "none",
      staged: false,
      evidence: [],
    });
    expect(changed[0]?.attribution).toEqual({
      kind: "baseline-comparison",
      staged: true,
      evidence: [
        "changed-entity:function:src/parser.ts:parseOrder",
        `target-only:${changed[0]?.id}`,
      ],
    });
  });

  it("uses explicit repository delta evidence for repository-scoped findings", () => {
    const repositoryFinding = createObservation({
      identity: "dependency-cycle:core->api",
      location: undefined,
    });
    const findings = compareObservationSets([], [repositoryFinding], {
      ...noChangeEvidence,
      repositoryDelta: true,
    });

    expect(findings[0]?.attribution).toEqual({
      kind: "baseline-comparison",
      staged: true,
      evidence: ["repository-delta", `target-only:${findings[0]?.id}`],
    });
  });

  it("does not apply repository delta evidence to location- or entity-scoped findings", () => {
    const entityTarget = createObservation({
      identity: "function:src/parser.ts:parseOrder",
      location: undefined,
      entity: { kind: "function", name: "parseOrder", file: "src/parser.ts" },
    });
    const findings = compareObservationSets([], [target, entityTarget], {
      ...noChangeEvidence,
      repositoryDelta: true,
    });

    expect(findings.map((finding) => finding.attribution)).toEqual([
      { kind: "none", staged: false, evidence: [] },
      { kind: "none", staged: false, evidence: [] },
    ]);
  });

  it("does not baseline-attribute metric observations delegated to metric comparison", () => {
    const metric = createObservation({
      identity: "function:src/value.ts:parse",
      metric: { name: "cyclomatic-complexity", value: 26, limit: 20 },
    });
    const findings = compareObservationSets([], [metric], {
      changedPaths: ["src/value.ts"],
      changedEntityIdentities: ["function:src/value.ts:parse"],
      repositoryDelta: true,
    });

    expect(findings[0]?.attribution).toEqual({
      kind: "none",
      staged: false,
      evidence: [],
    });
  });

  it("handles duplicate fingerprints deterministically as a multiset", () => {
    const alpha = { ...target, message: "Alpha target message" };
    const zulu = { ...target, message: "Zulu target message" };
    const evidence = {
      ...noChangeEvidence,
      changedPaths: ["src/value.ts"],
      addedRanges: [{ file: "src/value.ts", start: 2, end: 2 }],
    };

    const forward = compareObservationSets([target], [alpha, zulu], evidence);
    const reverse = compareObservationSets([target], [zulu, alpha], evidence);

    expect(reverse).toEqual(forward);
    expect(forward).toHaveLength(2);
    expect(
      forward.filter((finding) => finding.attribution.staged),
    ).toHaveLength(1);
  });

  it("uses code-unit ordering without consulting the host locale", () => {
    const original = String.prototype.localeCompare;
    String.prototype.localeCompare = () => {
      throw new Error("locale ordering must not be consulted");
    };
    try {
      const composed = { ...target, message: "\u00e9" };
      const decomposed = { ...target, message: "e\u0301" };
      const findings = compareObservationSets(
        [target],
        [composed, decomposed],
        {
          ...noChangeEvidence,
          changedPaths: ["src/value.ts"],
          addedRanges: [{ file: "src/value.ts", start: 2, end: 2 }],
        },
      );

      expect(findings).toHaveLength(2);
      expect(
        findings.filter((finding) => finding.attribution.staged),
      ).toHaveLength(1);
    } finally {
      String.prototype.localeCompare = original;
    }
  });

  it("uses one immutable snapshot for fingerprinting and finding output", () => {
    let checkReads = 0;
    let messageReads = 0;
    const untrusted = Object.defineProperties(
      { ...target },
      {
        check: {
          get() {
            checkReads += 1;
            return checkReads === 1 ? "types" : "changed-check";
          },
        },
        message: {
          get() {
            messageReads += 1;
            return messageReads === 1 ? "Original message" : "Changed message";
          },
        },
        unknown: {
          enumerable: true,
          get() {
            throw new Error("unknown getter must not run");
          },
        },
      },
    );

    const [finding] = compareObservationSets([], [untrusted], {
      ...noChangeEvidence,
      changedPaths: ["src/value.ts"],
    });

    expect(checkReads).toBe(1);
    expect(messageReads).toBe(1);
    expect(finding?.check).toBe("types");
    expect(finding?.message).toBe("Original message");
    expect(finding?.id).toBe(
      fingerprintObservation(
        createObservation({
          ...target,
          check: "types",
          message: "Original message",
        }),
      ),
    );
  });

  it("preserves public target details while stripping observation-only and runtime fields", () => {
    const contaminated = {
      ...target,
      sourceContents: "const password = 'top-secret-token'",
      temporaryRoot: "/private/tmp/zedbee-snapshot",
      adapterExtra: "must-not-render",
    };
    const [finding] = compareObservationSets([], [contaminated], {
      ...noChangeEvidence,
      changedPaths: ["src/value.ts"],
      addedRanges: [{ file: "src/value.ts", start: 2, end: 2 }],
    });

    expect(finding).toEqual({
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      check: target.check,
      rule: target.rule,
      severity: target.severity,
      message: target.message,
      location: target.location,
      remediation: target.remediation,
      attribution: {
        kind: "range-overlap",
        staged: true,
        evidence: expect.any(Array),
      },
    });
    expect(JSON.stringify(finding)).not.toContain("top-secret-token");
    expect(JSON.stringify(finding)).not.toContain("/private/tmp");
    expect(JSON.stringify(finding)).not.toContain("must-not-render");
  });

  it.each([
    "/private/tmp/zedbee-snapshot/src/value.ts",
    "C:\\temp\\snapshot\\src\\value.ts",
    "C:secret.ts",
    "../outside.ts",
    "src/\u0001secret.ts",
    "src/\u007fsecret.ts",
  ])("fails closed on unsafe changed path evidence %j", (changedPath) => {
    expect(() =>
      compareObservationSets([], [target], {
        ...noChangeEvidence,
        changedPaths: [changedPath],
      }),
    ).toThrow(/repository-relative path/i);
  });

  it.each([
    "function:src/value.ts:parse\u0001secret",
    "function:src/value.ts:parse\u007fsecret",
  ])("fails closed on unsafe changed entity evidence %j", (identity) => {
    expect(() =>
      compareObservationSets([], [target], {
        ...noChangeEvidence,
        changedEntityIdentities: [identity],
      }),
    ).toThrow(/canonical changed entity identity/i);
  });

  it("keeps evidence free of message, source, secret, and temporary-path data", () => {
    const secretMessageTarget = {
      ...target,
      message: "top-secret-token in /private/tmp/zedbee-snapshot",
      remediation: "source: const secret = 'top-secret-token'",
    };
    const [finding] = compareObservationSets([], [secretMessageTarget], {
      ...noChangeEvidence,
      changedPaths: ["src/value.ts"],
    });
    const evidence = finding?.attribution.evidence.join("\n") ?? "";

    expect(evidence).not.toContain("top-secret-token");
    expect(evidence).not.toContain("/private/tmp");
    expect(evidence).not.toContain("const secret");
  });
});
