import { describe, expect, it } from "vitest";
import {
  PUBLIC_ATTRIBUTION_FIELDS,
  PUBLIC_CHECK_ERROR_FIELDS,
  PUBLIC_CHECK_RESULT_FIELDS,
  PUBLIC_FINDING_FIELDS,
  PUBLIC_LOCATION_FIELDS,
  PUBLIC_SOURCE_EXCERPT_FIELDS,
} from "../../src/checks/sanitize-result.js";
import { sanitizeCheckResult } from "../../src/checks/sanitize-result.js";
import {
  PUBLIC_CHECK_TARGET_FIELDS,
  sanitizeCheckTarget,
} from "../../src/checks/sanitize-target.js";
import type { CheckResult } from "../../src/core/types.js";

const lintAutomaticFix = {
  available: true,
  command: ["npx", "--no-install", "zedbee", "fix", "lint"],
  scope: "finding",
  writes: "working-tree",
  stagesChanges: false,
} as const;

describe("public result sanitizer contract", () => {
  it("copies only supported source-free automatic fix guidance", () => {
    const result = sanitizeCheckResult({
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
          automaticFix: lintAutomaticFix,
          attribution: { kind: "none", staged: false, evidence: [] },
        },
      ],
    } as CheckResult);

    expect(result.findings[0]?.automaticFix).toEqual(lintAutomaticFix);
    expect(Object.isFrozen(result.findings[0]?.automaticFix?.command)).toBe(
      true,
    );
  });

  it.each([
    [
      "malformed command",
      { ...lintAutomaticFix, command: ["zedbee fix lint"] },
    ],
    [
      "control character command",
      {
        ...lintAutomaticFix,
        command: ["npx", "--no-install", "zedbee", "fix", "lint\n"],
      },
    ],
    ["unsupported availability", { ...lintAutomaticFix, available: false }],
    ["staging behavior", { ...lintAutomaticFix, stagesChanges: true }],
    ["extra payload", { ...lintAutomaticFix, replacement: "const secret = 1" }],
  ])("rejects %s automatic fix metadata", (_label, automaticFix) => {
    expect(() =>
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
            automaticFix,
            attribution: { kind: "none", staged: false, evidence: [] },
          },
        ],
      } as CheckResult),
    ).toThrow(/automatic fix|supported/i);
  });

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
      "incompleteDisposition",
    ]);
    expect(Object.keys(PUBLIC_FINDING_FIELDS)).toEqual([
      "id",
      "check",
      "rule",
      "severity",
      "message",
      "location",
      "remediation",
      "automaticFix",
      "sourceExcerpt",
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
    expect(Object.keys(PUBLIC_SOURCE_EXCERPT_FIELDS)).toEqual([
      "line",
      "text",
      "redacted",
      "truncated",
    ]);
    expect(Object.keys(PUBLIC_CHECK_ERROR_FIELDS)).toEqual([
      "code",
      "message",
      "path",
      "paths",
      "snapshot",
      "projectPaths",
      "temporaryPath",
      "remediation",
    ]);
    expect(Object.keys(PUBLIC_CHECK_TARGET_FIELDS)).toEqual([
      "id",
      "kind",
      "relativeRoot",
    ]);
  });

  it("preserves actionable safe error fields", () => {
    const result = sanitizeCheckResult({
      checkId: "formatting",
      status: "incomplete",
      durationMs: 1,
      findings: [],
      error: {
        code: "PRETTIER_FAILED",
        message: "Prettier could not analyze the staged file.",
        path: "src/value.ts",
        remediation: "Fix the parser error and stage the result.",
      },
    } as CheckResult);

    expect(result.error).toEqual({
      code: "PRETTIER_FAILED",
      message: "Prettier could not analyze the staged file.",
      path: "src/value.ts",
      remediation: "Fix the parser error and stage the result.",
    });
  });

  it.each(["block", "warn"] as const)(
    "preserves the exact incomplete disposition %s",
    (incompleteDisposition) => {
      const result = sanitizeCheckResult({
        checkId: "vulnerabilities",
        status: "incomplete",
        durationMs: 1,
        findings: [],
        incompleteDisposition,
        error: {
          code: "OSV_UNAVAILABLE",
          message: "OSV is unavailable.",
          remediation: "Retry when connectivity is restored.",
        },
      } as CheckResult);

      expect(result.incompleteDisposition).toBe(incompleteDisposition);
      expect(result.status).toBe("incomplete");
    },
  );

  it("rejects incomplete disposition on a completed result", () => {
    expect(() =>
      sanitizeCheckResult({
        checkId: "vulnerabilities",
        status: "completed",
        durationMs: 1,
        findings: [],
        incompleteDisposition: "warn",
      } as CheckResult),
    ).toThrow(/incomplete disposition/i);
  });

  it.each(["/repo/src/value.ts", "../outside.ts", "src/unsafe\u001b.ts"])(
    "rejects an unsafe repository error path %j",
    (path) => {
      expect(() =>
        sanitizeCheckResult({
          checkId: "formatting",
          status: "incomplete",
          durationMs: 1,
          findings: [],
          error: {
            code: "PRETTIER_FAILED",
            message: "Prettier failed.",
            path,
          },
        } as CheckResult),
      ).toThrow(/repository-relative path/i);
    },
  );

  it("rejects an adapter-supplied temporary path", () => {
    expect(() =>
      sanitizeCheckResult({
        checkId: "formatting",
        status: "incomplete",
        durationMs: 1,
        findings: [],
        error: {
          code: "PRETTIER_FAILED",
          message: "Prettier failed.",
          temporaryPath: "/tmp/adapter-controlled",
        },
      } as CheckResult),
    ).toThrow(/temporary path/i);
  });

  it("sanitizes a source excerpt without collapsing code indentation", () => {
    const result = sanitizeCheckResult({
      checkId: "formatting",
      status: "completed",
      durationMs: 1,
      findings: [
        {
          id: "formatting:src/value.ts:2",
          check: "formatting",
          rule: "prettier",
          severity: "error",
          message: "Formatting differs.",
          location: { file: "src/value.ts", startLine: 2, endLine: 2 },
          sourceExcerpt: {
            line: 2,
            text: "  const BIDI_MARKER = 'before\u202eafter';\u001b[31m",
            redacted: false,
            truncated: false,
          },
          attribution: {
            kind: "transformation-diff",
            staged: true,
            evidence: [],
          },
        },
      ],
    } as CheckResult);

    expect(result.findings[0]?.sourceExcerpt).toEqual({
      line: 2,
      text: "  const BIDI_MARKER = 'before�after';�[31m",
      redacted: false,
      truncated: false,
    });
  });

  it("redacts source text based on the secrets finding identity", () => {
    const result = sanitizeCheckResult({
      checkId: "secrets",
      status: "completed",
      durationMs: 1,
      findings: [
        {
          id: "secrets:src/value.ts:2",
          check: "secrets",
          rule: "generic-api-key",
          severity: "error",
          message: "A staged secret was detected.",
          location: { file: "src/value.ts", startLine: 2, endLine: 2 },
          sourceExcerpt: {
            line: 2,
            text: "SECRET-MUST-NOT-LEAK",
            redacted: false,
            truncated: true,
          },
          attribution: {
            kind: "range-overlap",
            staged: true,
            evidence: [],
          },
        },
      ],
    });

    expect(result.findings[0]?.sourceExcerpt).toEqual({
      line: 2,
      redacted: true,
      truncated: false,
    });
    expect(JSON.stringify(result)).not.toContain("SECRET-MUST-NOT-LEAK");
  });

  it.each([
    ["mismatched line", { line: 3, text: "const value = 1;" }],
    ["oversized text", { line: 2, text: "x".repeat(501) }],
  ])("rejects a source excerpt with %s", (_label, excerpt) => {
    expect(() =>
      sanitizeCheckResult({
        checkId: "formatting",
        status: "completed",
        durationMs: 1,
        findings: [
          {
            id: "formatting:src/value.ts:2",
            check: "formatting",
            rule: "prettier",
            severity: "error",
            message: "Formatting differs.",
            location: { file: "src/value.ts", startLine: 2, endLine: 2 },
            sourceExcerpt: {
              ...excerpt,
              redacted: false,
              truncated: false,
            },
            attribution: {
              kind: "transformation-diff",
              staged: true,
              evidence: [],
            },
          },
        ],
      } as CheckResult),
    ).toThrow(/source excerpt/i);
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
