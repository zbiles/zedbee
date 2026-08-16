import { describe, expect, it } from "vitest";
import {
  PUBLIC_ATTRIBUTION_FIELDS,
  PUBLIC_CHECK_ERROR_FIELDS,
  PUBLIC_CHECK_RESULT_FIELDS,
  PUBLIC_FINDING_FIELDS,
  PUBLIC_LOCATION_FIELDS,
} from "../../src/checks/sanitize-result.js";
import { sanitizeCheckResult } from "../../src/checks/sanitize-result.js";
import {
  PUBLIC_CHECK_TARGET_FIELDS,
  sanitizeCheckTarget,
} from "../../src/checks/sanitize-target.js";
import type { CheckResult } from "../../src/core/types.js";

describe("public result sanitizer contract", () => {
  it("requires an intentional sanitizer update for every new public field", () => {
    // Each production registry also `satisfies Record<keyof Contract, true>`,
    // so adding a contract field without updating the sanitizer fails typecheck.
    expect(Object.keys(PUBLIC_CHECK_RESULT_FIELDS)).toEqual([
      "checkId",
      "target",
      "status",
      "durationMs",
      "findings",
      "error",
      "skipReason",
    ]);
    expect(Object.keys(PUBLIC_FINDING_FIELDS)).toEqual([
      "id",
      "check",
      "rule",
      "severity",
      "message",
      "location",
      "remediation",
      "attribution",
    ]);
    expect(Object.keys(PUBLIC_LOCATION_FIELDS)).toEqual([
      "file",
      "startLine",
      "startColumn",
      "endLine",
      "endColumn",
    ]);
    expect(Object.keys(PUBLIC_ATTRIBUTION_FIELDS)).toEqual([
      "kind",
      "staged",
      "evidence",
    ]);
    expect(Object.keys(PUBLIC_CHECK_ERROR_FIELDS)).toEqual(["code", "message"]);
    expect(Object.keys(PUBLIC_CHECK_TARGET_FIELDS)).toEqual([
      "id",
      "kind",
      "relativeRoot",
    ]);
  });

  it.each([
    ["ANSI", "unsafe\u001b[31mtext"],
    ["CRLF", "unsafe\r\ntext"],
    ["bidi", "unsafe\u202etext"],
    ["oversized", "x".repeat(4097)],
  ])("rejects %s display text", (_label, message) => {
    expect(() =>
      sanitizeCheckResult({
        checkId: "lint",
        status: "incomplete",
        durationMs: 0,
        findings: [],
        error: { code: "FAILED", message },
      }),
    ).toThrow(/display text/i);
  });

  it.each<
    [
      string,
      {
        status?: string;
        finding?: { severity?: string; kind?: string; staged?: string };
      },
    ]
  >([
    ["status", { status: "completed.toUpperCase()" }],
    ["severity", { finding: { severity: "error.toUpperCase()" } }],
    ["attribution kind", { finding: { kind: "range-overlap.verbose" } }],
    ["attribution staged", { finding: { staged: "true" } }],
  ])(
    "rejects an invalid runtime %s enum before rendering",
    (_label, mutation) => {
      const finding = {
        id: "finding",
        check: "lint",
        rule: "rule",
        severity: mutation.finding?.severity ?? "error",
        message: "message",
        attribution: {
          kind: mutation.finding?.kind ?? "syntax-ownership",
          staged: mutation.finding?.staged ?? true,
          evidence: [],
        },
      };
      const result = {
        checkId: "lint",
        status: mutation.status ?? "completed",
        durationMs: 0,
        findings: [finding],
      } as unknown as CheckResult;

      expect(() => sanitizeCheckResult(result)).toThrow(/invalid|expected/i);
    },
  );

  it.each([
    "range-overlap",
    "syntax-ownership",
    "transformation-diff",
    "baseline-comparison",
    "metric-delta",
    "none",
  ] as const)("accepts the exact supported attribution kind %s", (kind) => {
    expect(
      sanitizeCheckResult({
        checkId: "lint",
        status: "completed",
        durationMs: 0,
        findings: [
          {
            id: "finding",
            check: "lint",
            rule: "rule",
            severity: "error",
            message: "message",
            attribution: { kind, staged: true, evidence: [] },
          },
        ],
      }).findings[0]?.attribution.kind,
    ).toBe(kind);
  });

  it.each([
    { id: "web", kind: "repository.verbose", relativeRoot: "." },
    { id: "web", kind: "workspace", relativeRoot: "apps/\u202eweb" },
    { id: "web", kind: "workspace", relativeRoot: `apps/${"x".repeat(256)}` },
    {
      id: "web",
      kind: "workspace",
      relativeRoot: `apps/${"x".repeat(4096)}`,
    },
  ])("rejects an invalid or unsafe target %#", (target) => {
    expect(() =>
      sanitizeCheckTarget(
        target as unknown as import("../../src/checks/adapter.js").CheckTarget,
      ),
    ).toThrow(/target|repository-relative path/i);
  });
});
