import { expect, it } from "vitest";
import ts from "typescript";
import {
  captureDiagnosticDetails,
  retainDiagnosticDetails,
  applyDiagnosticDetails,
  withDiagnosticDetailSession,
} from "../../src/checks/diagnostic-details.js";
import { convertTypescriptDiagnostic } from "../../src/checks/typescript/convert-diagnostic.js";
import { fingerprintObservation } from "../../src/attribution/fingerprint.js";

it("restores module and member names only in contextual final reports", async () => {
  await withDiagnosticDetailSession(async () => {
    const root = "/tmp/diagnostic-test";
    const source = ts.createSourceFile(
      root + "/value.ts",
      "import { Account } from './account';",
      ts.ScriptTarget.Latest,
    );
    const context = {
      snapshots: { targetDir: root },
      signal: new AbortController().signal,
    } as any;
    const set = await captureDiagnosticDetails(context, async () => ({
      checkId: "types",
      target: { id: ".", kind: "workspace" as const, relativeRoot: "." },
      baselineObservations: [],
      targetObservations: [
        convertTypescriptDiagnostic(
          {
            category: ts.DiagnosticCategory.Error,
            code: 2305,
            messageText: "Module './account' has no exported member 'Account'.",
            file: source,
            start: 0,
            length: 1,
          },
          root,
          root,
        )!,
      ],
    }));
    expect(set.targetObservations[0]!.message).toContain("[source]");
    retainDiagnosticDetails(set);
    const finding = {
      ...set.targetObservations[0],
      id: fingerprintObservation(set.targetObservations[0]!),
      attribution: { kind: "range-overlap", staged: true, evidence: [] },
    };
    const report = {
      checks: [{ findings: [finding] }],
      summary: { findings: [finding] },
    } as any;
    const contextual = applyDiagnosticDetails(report, "contextual");
    expect(contextual.summary.findings[0].message).toBe(
      "Module './account' has no exported member 'Account'.",
    );
    expect(
      applyDiagnosticDetails(report, "source-free").summary.findings[0].message,
    ).toContain("[source]");
    expect(contextual.summary.findings[0].id).toBe(finding.id);
  });
});

it.each([
  [
    "@typescript-eslint/require-await",
    "Async arrow function has no 'await' expression.",
    "export const f=async()=>1;",
    false,
  ],
  [
    "typescript/TS2875",
    "This JSX tag requires the module path 'react/jsx-runtime' to exist, but none could be found. Make sure you have types for the appropriate package installed.",
    "export const f=<div/>;",
    false,
  ],
  [
    "typescript/TS2305",
    "Module 'https://user:password@host/path' has no exported member 'Account'.",
    "export const x=1;",
    true,
  ],
  [
    "typescript/TS2304",
    "Cannot find name 'aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6uX9z'.",
    'const AWS_SECRET_ACCESS_KEY = "aB3dE6gH9jK2mN5pQ8sT1vW4yZ7cF0iL3oR6uX9z";',
    true,
  ],
] as const)(
  "reviews %s prose using captured context",
  async (rule, original, content, redacted) => {
    const { recordDiagnosticDetail } =
      await import("../../src/checks/diagnostic-details.js");
    const root = "/tmp/diagnostic-test";
    const observation = {
      check: rule.startsWith("typescript/") ? "types" : "lint",
      rule,
      identity: rule,
      severity: "error" as const,
      message: "Problem with [source].",
      location: { file: "value.ts", startLine: 1, startColumn: 1 },
    };
    const set = await captureDiagnosticDetails(
      {
        snapshots: { targetDir: root },
        signal: new AbortController().signal,
      } as any,
      async () => {
        recordDiagnosticDetail(observation, original, root, content);
        return {
          checkId: observation.check,
          target: { id: ".", kind: "workspace" as const, relativeRoot: "." },
          baselineObservations: [],
          targetObservations: [observation],
        };
      },
    );
    expect(set.diagnosticDetails?.[0]?.redaction?.redacted === true).toBe(
      redacted,
    );
    if (!redacted) expect(set.diagnosticDetails?.[0]?.message).toBe(original);
    else expect(set.diagnosticDetails?.[0]?.message).not.toBe(original);
    if (original.includes("https://"))
      expect(set.diagnosticDetails?.[0]?.message).toContain("Account");
  },
);

it("does not reuse details across scan sessions", async () => {
  await withDiagnosticDetailSession(async () => {
    const finding = {
      id: "a".repeat(64),
      check: "types",
      rule: "typescript/TS2304",
      message: "Cannot find name '[source]'.",
      severity: "error",
      attribution: { kind: "none", staged: false, evidence: [] },
    } as any;
    const report = {
      checks: [{ findings: [finding] }],
      summary: { findings: [finding] },
    } as any;
    expect(
      applyDiagnosticDetails(report, "contextual").summary.findings[0].message,
    ).not.toContain("Account");
  });
});

it("retains warm-cache eligibility for clean and unsupported diagnostics", async () => {
  const { needsContextualDiagnosticDetails } =
    await import("../../src/checks/diagnostic-details.js");
  const set = {
    checkId: "types",
    target: { id: ".", kind: "workspace" as const, relativeRoot: "." },
    baselineObservations: [],
    targetObservations: [],
  };
  expect(needsContextualDiagnosticDetails(set)).toBe(false);
  const observation = {
    check: "types",
    rule: "typescript/TS2322",
    identity: "type",
    severity: "error" as const,
    message: "Type '[source]' is not assignable to type '[source]'.",
  };
  expect(
    needsContextualDiagnosticDetails({
      ...set,
      targetObservations: [observation],
    }),
  ).toBe(false);
  expect(
    needsContextualDiagnosticDetails({
      ...set,
      targetObservations: [{ ...observation, rule: "typescript/TS2305" }],
    }),
  ).toBe(true);
});

it("rejects malformed and unbounded private detail envelopes", async () => {
  const { sanitizeDiagnosticDetails } =
    await import("../../src/checks/diagnostic-details.js");
  expect(() =>
    sanitizeDiagnosticDetails(Array.from({ length: 257 }, () => ({}))),
  ).toThrow();
  expect(() =>
    sanitizeDiagnosticDetails([{ findingId: "x", message: "safe" }]),
  ).toThrow();
  expect(() =>
    sanitizeDiagnosticDetails([
      { findingId: "a".repeat(64), message: "unsafe\u001b[31m" },
    ]),
  ).toThrow();
});
