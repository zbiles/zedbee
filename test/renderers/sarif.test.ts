import { describe, expect, it } from "vitest";
import type { CheckExecutionResult } from "../../src/checks/adapter.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { ZEDBEE_VERSION } from "../../src/core/package-version.js";
import type { IncompleteDisposition } from "../../src/core/types.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";
import { renderJson } from "../../src/renderers/json.js";
import { renderSarif } from "../../src/renderers/sarif.js";
import { renderText } from "../../src/renderers/text.js";
import { createFinding, createReport } from "../helpers/scan-report.js";

function reportFromIncompletePolicy(
  failOnIncomplete: boolean,
  inputs: readonly {
    readonly checkId: string;
    readonly code: string;
    readonly disposition?: IncompleteDisposition;
  }[],
) {
  const config = resolveConfig({
    schemaVersion: 1,
    profile: "recommended",
    failOnIncomplete,
  });
  const executions: readonly CheckExecutionResult[] = inputs.map((input) => ({
    result: {
      checkId: input.checkId,
      status: "incomplete",
      durationMs: 2,
      findings: [],
      ...(input.disposition === undefined
        ? {}
        : { incompleteDisposition: input.disposition }),
      error: {
        code: input.code,
        message: `${input.checkId} could not complete.`,
      },
    },
    policy: config.checks.formatting,
  }));
  const decision = evaluatePolicy(executions, config);
  return createReport({
    outcome: decision.outcome,
    exitCode: decision.exitCode,
    summary: decision.summary,
    checks: decision.results,
  });
}

describe("renderSarif", () => {
  it("renders a deterministic SARIF 2.1.0 document envelope", () => {
    const report = createReport({
      presentationPolicy: {
        terminalFindingLimit: "all",
        temporaryReportRetention: 9,
        persistSourceExcerpts: true,
      },
    });
    const first = renderSarif(report);
    const second = renderSarif(report);
    const document = JSON.parse(first) as Record<string, unknown>;

    expect(first).toBe(second);
    expect(first).not.toContain("presentationPolicy");
    expect(document).toMatchObject({
      $schema: "https://json.schemastore.org/sarif-2.1.0.json",
      version: "2.1.0",
      runs: [
        {
          tool: {
            driver: {
              name: "Zedbee",
              semanticVersion: ZEDBEE_VERSION,
              informationUri: "https://github.com/zbiles/Zedbee",
              rules: [],
            },
          },
          results: [],
        },
      ],
    });
    expect(first.endsWith("\n")).toBe(false);
  });

  it("maps every finding to deterministic rules, levels, locations, and properties", () => {
    const error = createFinding({
      id: "finding-error",
      check: "types",
      rule: "2322",
      severity: "error",
      message: "Type 'string' is not assignable to type 'number'.",
      location: {
        file: "packages/app/src/file name.ts",
        startLine: 12,
        startColumn: 5,
        endLine: 14,
        endColumn: 9,
      },
      sourceExcerpt: {
        line: 12,
        text: "const answer: number = 'forty-two';",
        redacted: false,
        truncated: true,
      },
      remediation: "Assign a number instead.",
      attribution: {
        kind: "range-overlap",
        staged: true,
        evidence: ["target line 14", "target line 12"],
      },
    });
    const info = createFinding({
      id: "finding-info",
      check: "formatting",
      rule: "prettier",
      severity: "info",
      message: "Formatting differs.",
      location: { file: "src/format.ts", startLine: 2 },
    });
    const warning = createFinding({
      id: "finding-warning",
      check: "lint",
      rule: "no-alert",
      severity: "warning",
      message: "Unexpected alert.",
      location: { file: "src/alert.ts", startLine: 7, startColumn: 3 },
      sourceExcerpt: {
        line: 7,
        redacted: true,
        truncated: false,
      },
      remediation: "Use the notification service.",
    });
    const duplicateRule = createFinding({
      id: "finding-error-2",
      check: "types",
      rule: "2322",
      severity: "error",
      message: "A second type mismatch.",
      location: { file: "packages/app/src/another.ts", startLine: 1 },
    });
    const report = createReport({
      outcome: "blocked",
      exitCode: 1,
      summary: {
        passed: 0,
        warnings: 2,
        failed: 2,
        incomplete: 0,
        findings: [error, warning, duplicateRule, info],
      },
      checks: [],
    });

    const document = JSON.parse(renderSarif(report)) as {
      runs: Array<{
        tool: { driver: { rules: Array<Record<string, unknown>> } };
        results: Array<Record<string, any>>;
      }>;
    };
    const run = document.runs[0]!;

    expect(run.tool.driver.rules).toEqual([
      {
        id: "formatting/prettier",
        shortDescription: { text: "Formatting: prettier" },
        properties: { checkId: "formatting", ruleId: "prettier" },
      },
      {
        id: "lint/no-alert",
        shortDescription: { text: "Lint: no-alert" },
        properties: { checkId: "lint", ruleId: "no-alert" },
      },
      {
        id: "types/2322",
        shortDescription: { text: "TypeScript: 2322" },
        properties: { checkId: "types", ruleId: "2322" },
      },
    ]);
    expect(run.results.map((result) => result.partialFingerprints)).toEqual([
      { "zedbee/v1": "finding-info" },
      { "zedbee/v1": "finding-warning" },
      { "zedbee/v1": "finding-error-2" },
      { "zedbee/v1": "finding-error" },
    ]);
    expect(run.results.map((result) => result.level)).toEqual([
      "warning",
      "warning",
      "error",
      "error",
    ]);

    const serializedError = run.results[3]!;
    expect(serializedError).toMatchObject({
      ruleId: "types/2322",
      ruleIndex: 2,
      level: "error",
      message: {
        text: "Type 'string' is not assignable to type 'number'.",
      },
      partialFingerprints: { "zedbee/v1": "finding-error" },
      locations: [
        {
          physicalLocation: {
            artifactLocation: {
              uri: "packages/app/src/file%20name.ts",
            },
            region: {
              startLine: 12,
              startColumn: 5,
              endLine: 14,
              endColumn: 9,
              snippet: { text: "const answer: number = 'forty-two';" },
            },
          },
        },
      ],
      properties: {
        checkId: "types",
        ruleId: "2322",
        attributionKind: "range-overlap",
        staged: true,
        evidence: ["target line 12", "target line 14"],
        remediation: "Assign a number instead.",
        sourceExcerptTruncated: true,
      },
    });
    expect(Object.hasOwn(serializedError, "fixes")).toBe(false);

    const serializedWarning = run.results[1]!;
    expect(
      Object.hasOwn(
        serializedWarning.locations[0].physicalLocation.region,
        "snippet",
      ),
    ).toBe(false);
    expect(JSON.stringify(serializedWarning)).not.toContain("sourceExcerpt");
    expect((run as any).invocations[0].executionSuccessful).toBe(true);
  });

  it.each([
    {
      name: "an infinite start line",
      location: {
        file: "src/infinite.ts",
        startLine: Number.POSITIVE_INFINITY,
        startColumn: 2,
        endLine: 5,
        endColumn: 4,
      },
      expectedRegion: undefined,
    },
    {
      name: "fractional and infinite optional coordinates",
      location: {
        file: "src/fractional.ts",
        startLine: 3,
        startColumn: 2.5,
        endLine: 4.25,
        endColumn: Number.POSITIVE_INFINITY,
      },
      expectedRegion: { startLine: 3 },
    },
    {
      name: "an end line before the start line",
      location: {
        file: "src/reversed-lines.ts",
        startLine: 8,
        startColumn: 4,
        endLine: 7,
        endColumn: 10,
      },
      expectedRegion: { startLine: 8, startColumn: 4 },
    },
    {
      name: "a reversed same-line column range",
      location: {
        file: "src/reversed-columns.ts",
        startLine: 10,
        startColumn: 8,
        endLine: 10,
        endColumn: 3,
      },
      expectedRegion: { startLine: 10, startColumn: 8, endLine: 10 },
    },
  ])(
    "omits invalid SARIF coordinates for $name",
    ({ location, expectedRegion }) => {
      const finding = createFinding({ location });
      const report = createReport({
        summary: {
          passed: 0,
          warnings: 0,
          failed: 1,
          incomplete: 0,
          findings: [finding],
        },
      });

      const document = JSON.parse(renderSarif(report)) as {
        runs: Array<{
          results: Array<{
            locations: Array<{
              physicalLocation: Record<string, unknown>;
            }>;
          }>;
        }>;
      };
      const physicalLocation =
        document.runs[0]!.results[0]!.locations[0]!.physicalLocation;

      if (expectedRegion === undefined) {
        expect(Object.hasOwn(physicalLocation, "region")).toBe(false);
      } else {
        expect(physicalLocation.region).toEqual(expectedRegion);
      }
    },
  );

  it("preserves coherent multiline coordinates and a valid snippet", () => {
    const finding = createFinding({
      location: {
        file: "src/multiline.ts",
        startLine: 12,
        startColumn: 9,
        endLine: 14,
        endColumn: 3,
      },
      sourceExcerpt: {
        line: 12,
        text: "const value = beginCall(",
        redacted: false,
        truncated: false,
      },
    });
    const report = createReport({
      summary: {
        passed: 0,
        warnings: 0,
        failed: 1,
        incomplete: 0,
        findings: [finding],
      },
    });

    const document = JSON.parse(renderSarif(report)) as {
      runs: Array<{
        results: Array<{
          locations: Array<{
            physicalLocation: { region: Record<string, unknown> };
          }>;
        }>;
      }>;
    };

    expect(
      document.runs[0]!.results[0]!.locations[0]!.physicalLocation.region,
    ).toEqual({
      startLine: 12,
      startColumn: 9,
      endLine: 14,
      endColumn: 3,
      snippet: { text: "const value = beginCall(" },
    });
  });

  it("maps incomplete checks to ordered invocation notifications and canonical metadata", () => {
    const report = createReport({
      outcome: "incomplete",
      exitCode: 2,
      baseline: null,
      stagedFileCount: null,
      networkDisclosures: [
        {
          checkId: "vulnerabilities",
          target: ".",
          services: ["mirror.example", "api.osv.dev"],
          metadata: ["versions", "package names"],
        },
      ],
      summary: {
        passed: 0,
        warnings: 0,
        failed: 0,
        incomplete: 2,
        findings: [],
      },
      checks: [
        {
          checkId: "vulnerabilities",
          target: "packages/api",
          status: "incomplete",
          incompleteDisposition: "warn",
          durationMs: 8,
          findings: [],
          error: {
            code: "OSV_UNAVAILABLE",
            message: "OSV is temporarily unavailable.",
            remediation: "Try again later.",
          },
        },
        {
          checkId: "formatting",
          status: "incomplete",
          incompleteDisposition: "block",
          durationMs: 3,
          findings: [],
          error: {
            code: "PRETTIER_FAILED",
            message: "Prettier could not parse the staged file.",
            path: "src/file name.ts",
            remediation: "Fix the syntax error.",
          },
        },
      ],
    });

    const document = JSON.parse(renderSarif(report)) as {
      runs: Array<{
        results: unknown[];
        invocations: Array<Record<string, any>>;
      }>;
    };
    const run = document.runs[0]!;
    const invocation = run.invocations[0]!;

    expect(run.results).toEqual([]);
    expect(invocation.executionSuccessful).toBe(false);
    expect(invocation.startTimeUtc).toBe("2026-08-15T00:00:00.000Z");
    expect(invocation.properties).toEqual({
      schemaVersion: 1,
      outcome: "incomplete",
      exitCode: 2,
      baseline: null,
      target: "index",
      stagedFileCount: null,
      startedAt: "2026-08-15T00:00:00.000Z",
      durationMs: 15,
      networkDisclosures: [
        {
          checkId: "vulnerabilities",
          target: ".",
          services: ["api.osv.dev", "mirror.example"],
          metadata: ["package names", "versions"],
        },
      ],
    });
    expect(invocation.toolExecutionNotifications).toEqual([
      {
        descriptor: { id: "PRETTIER_FAILED" },
        level: "error",
        message: { text: "Prettier could not parse the staged file." },
        properties: {
          checkId: "formatting",
          errorCode: "PRETTIER_FAILED",
          disposition: "block",
          durationMs: 3,
          path: "src/file name.ts",
          remediation: "Fix the syntax error.",
        },
      },
      {
        descriptor: { id: "OSV_UNAVAILABLE" },
        level: "warning",
        message: { text: "OSV is temporarily unavailable." },
        properties: {
          checkId: "vulnerabilities",
          errorCode: "OSV_UNAVAILABLE",
          disposition: "warn",
          target: "packages/api",
          durationMs: 8,
          remediation: "Try again later.",
        },
      },
    ]);
  });

  it("renders a default fail-open incomplete check as a warning with warn disposition", () => {
    const report = reportFromIncompletePolicy(false, [
      { checkId: "formatting", code: "PRETTIER_FAILED" },
    ]);

    const document = JSON.parse(renderSarif(report)) as {
      runs: Array<{ invocations: Array<Record<string, any>> }>;
    };
    const invocation = document.runs[0]!.invocations[0]!;

    expect(invocation).toMatchObject({
      executionSuccessful: true,
      properties: { outcome: "pass", exitCode: 0 },
      toolExecutionNotifications: [
        {
          level: "warning",
          properties: {
            checkId: "formatting",
            disposition: "warn",
          },
        },
      ],
    });
  });

  it("renders a default fail-closed incomplete check as an error with block disposition", () => {
    const report = reportFromIncompletePolicy(true, [
      { checkId: "formatting", code: "PRETTIER_FAILED" },
    ]);

    const document = JSON.parse(renderSarif(report)) as {
      runs: Array<{ invocations: Array<Record<string, any>> }>;
    };
    const invocation = document.runs[0]!.invocations[0]!;

    expect(invocation).toMatchObject({
      executionSuccessful: false,
      properties: { outcome: "incomplete", exitCode: 2 },
      toolExecutionNotifications: [
        {
          level: "error",
          properties: {
            checkId: "formatting",
            disposition: "block",
          },
        },
      ],
    });
  });

  it("preserves mixed explicit block and warn dispositions through policy evaluation", () => {
    const report = reportFromIncompletePolicy(false, [
      {
        checkId: "vulnerabilities",
        code: "OSV_UNAVAILABLE",
        disposition: "warn",
      },
      {
        checkId: "formatting",
        code: "PRETTIER_FAILED",
        disposition: "block",
      },
    ]);

    const document = JSON.parse(renderSarif(report)) as {
      runs: Array<{ invocations: Array<Record<string, any>> }>;
    };
    const invocation = document.runs[0]!.invocations[0]!;

    expect(invocation).toMatchObject({
      executionSuccessful: false,
      properties: { outcome: "incomplete", exitCode: 2 },
      toolExecutionNotifications: [
        {
          level: "error",
          properties: {
            checkId: "formatting",
            disposition: "block",
          },
        },
        {
          level: "warning",
          properties: {
            checkId: "vulnerabilities",
            disposition: "warn",
          },
        },
      ],
    });
  });

  it("rejects unsafe display text consistently with the JSON and text renderers", () => {
    const report = createReport({
      outcome: "incomplete",
      exitCode: 2,
      summary: {
        passed: 0,
        warnings: 0,
        failed: 0,
        incomplete: 1,
        findings: [],
      },
      checks: [
        {
          checkId: "formatting",
          status: "incomplete",
          durationMs: 1,
          findings: [],
          error: {
            code: "PRETTIER_FAILED",
            message: "unsafe\u001b[2Jdiagnostic",
          },
        },
      ],
    });

    expect(() => renderSarif(report)).toThrow(/display text/i);
    expect(() => renderJson(report)).toThrow(/display text/i);
    expect(() => renderText(report, { width: 80, color: false })).toThrow(
      /display text/i,
    );
  });
});
