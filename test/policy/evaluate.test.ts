import { describe, expect, expectTypeOf, it } from "vitest";
import type { CheckExecutionResult } from "../../src/checks/adapter.js";
import type { ResolvedConfig } from "../../src/config/schema.js";
import { resolveConfig } from "../../src/config/profiles.js";
import { createFilePolicyResolver } from "../../src/config/file-policy.js";
import type {
  Attribution,
  CheckResult,
  Finding,
} from "../../src/core/types.js";
import { evaluatePolicy } from "../../src/policy/evaluate.js";

function config(
  severity: "off" | "warn" | "error" = "error",
  failOnIncomplete = true,
): ResolvedConfig {
  const resolved = resolveConfig({
    schemaVersion: 1,
    profile: "recommended",
    checks: { formatting: severity },
  });
  return {
    ...resolved,
    failOnIncomplete,
  };
}

function finding(
  staged: boolean,
  severity: Finding["severity"] = "info",
  file = "value.ts",
): Finding {
  return {
    id: `${staged ? "staged" : "existing"}:${file}`,
    check: "formatting",
    rule: "prettier",
    severity,
    message: "Format file",
    location: { file, startLine: staged ? 2 : 20 },
    attribution: {
      kind: staged ? "range-overlap" : "none",
      staged,
      evidence: staged ? ["value.ts:2"] : [],
    },
  };
}

function completed(findings: readonly Finding[] = []): CheckResult {
  return {
    checkId: "formatting",
    status: "completed",
    durationMs: 4,
    findings,
  };
}

function execution(
  result: CheckResult,
  severity: "off" | "warn" | "error" = "error",
): CheckExecutionResult {
  return {
    result,
    policy: Object.freeze({ severity, when: "relevant" }),
  };
}

const incomplete: CheckResult = {
  checkId: "formatting",
  status: "incomplete",
  durationMs: 2,
  findings: [],
  error: { code: "ENGINE_FAILED", message: "Formatting engine failed" },
};

describe("evaluatePolicy", () => {
  it("sanitizes execution envelopes supplied through the evaluator boundary", () => {
    const leakyFinding = {
      ...finding(true),
      policy: "finding leak",
      attribution: {
        ...finding(true).attribution,
        targetPolicy: "attribution leak",
      },
    } satisfies Finding & {
      policy: string;
      attribution: Attribution & { targetPolicy: string };
    };
    const untrustedResult = {
      ...completed([leakyFinding]),
      policy: "result leak",
      targetPolicy: "result leak",
    } satisfies CheckResult & { policy: string; targetPolicy: string };

    const decision = evaluatePolicy(
      [execution(untrustedResult, "warn")],
      config("warn"),
    );

    expect(JSON.stringify(decision)).not.toMatch(/policy/i);
    expect(Object.keys(decision.results[0]!)).toEqual([
      "checkId",
      "status",
      "durationMs",
      "findings",
    ]);
    expect(Object.keys(decision.results[0]!.findings[0]!)).toEqual([
      "id",
      "check",
      "rule",
      "severity",
      "message",
      "location",
      "attribution",
    ]);
  });

  it("requires the typed execution envelope so cloning a public result cannot discard policy", () => {
    expectTypeOf(evaluatePolicy)
      .parameter(0)
      .toEqualTypeOf<readonly CheckExecutionResult[]>();
    const execution: CheckExecutionResult = {
      result: completed([finding(true, "info")]),
      policy: Object.freeze({ severity: "error", when: "relevant" }),
    };
    const clonedExecution: CheckExecutionResult = {
      ...execution,
      result: { ...execution.result },
    };

    const decision = evaluatePolicy([clonedExecution], config("warn"));

    expect(decision).toMatchObject({ outcome: "blocked", exitCode: 1 });
    expect(decision.results[0]?.findings[0]?.severity).toBe("error");
  });

  it("passes a completed check with no attributed findings", () => {
    expect(evaluatePolicy([execution(completed())], config())).toMatchObject({
      exitCode: 0,
      outcome: "pass",
      summary: { passed: 1, warnings: 0, failed: 0, incomplete: 0 },
    });
  });

  it("blocks an attributed finding under error policy regardless of engine severity", () => {
    const decision = evaluatePolicy(
      [execution(completed([finding(true, "info")]), "error")],
      config("error"),
    );

    expect(decision).toMatchObject({
      exitCode: 1,
      outcome: "blocked",
      summary: { passed: 0, warnings: 0, failed: 1, incomplete: 0 },
    });
    expect(decision.summary.findings[0]?.severity).toBe("error");
  });

  it("reports an attributed finding without blocking under warn policy", () => {
    const decision = evaluatePolicy(
      [execution(completed([finding(true, "error")]), "warn")],
      config("warn"),
    );

    expect(decision).toMatchObject({
      exitCode: 0,
      outcome: "pass",
      summary: { warnings: 1, failed: 0 },
    });
    expect(decision.summary.findings[0]?.severity).toBe("warning");
  });

  it("filters findings that are not attributed to staged code", () => {
    const decision = evaluatePolicy(
      [execution(completed([finding(false, "error")]), "error")],
      config("error"),
    );

    expect(decision.exitCode).toBe(0);
    expect(decision.summary.findings).toEqual([]);
    expect(decision.results[0]?.findings).toEqual([]);
  });

  it("excludes results for disabled checks", () => {
    const decision = evaluatePolicy(
      [execution(completed([finding(true)]), "off")],
      config("off"),
    );

    expect(decision.exitCode).toBe(0);
    expect(decision.results).toEqual([]);
    expect(decision.summary.findings).toEqual([]);
  });

  it("applies warning, off, and blocking policy independently within one result", () => {
    const mixedConfig = resolveConfig({
      schemaVersion: 1,
      profile: "recommended",
      checks: { formatting: "error" },
      overrides: [
        { files: ["test/**"], checks: { formatting: "warn" } },
        { files: ["generated/**"], checks: { formatting: "off" } },
      ],
    });
    const result = completed([
      finding(true, "info", "src/block.ts"),
      finding(true, "error", "test/warn.test.ts"),
      finding(true, "error", "generated/off.ts"),
    ]);
    const policyForFile = createFilePolicyResolver(mixedConfig, {
      files: new Map(),
      isEmpty: true,
      containsAddedLine: () => false,
    });
    const mixedExecution = {
      ...execution(result, "error"),
      policyForFile,
    };

    const decision = evaluatePolicy([mixedExecution], mixedConfig);

    expect(decision).toMatchObject({
      outcome: "blocked",
      exitCode: 1,
      summary: { warnings: 1, failed: 1 },
    });
    expect(decision.results[0]?.findings).toEqual([
      expect.objectContaining({
        id: "staged:src/block.ts",
        severity: "error",
      }),
      expect.objectContaining({
        id: "staged:test/warn.test.ts",
        severity: "warning",
      }),
    ]);
  });

  it("suppresses only matching duplication fragments through path exclusions", () => {
    const duplicationConfig = resolveConfig({
      schemaVersion: 1,
      profile: "thorough",
      pathExclusions: [
        {
          files: ["generated/**"],
          checks: ["duplication"],
          reason: "Generated duplicates are not maintained by hand.",
        },
      ],
    });
    const policyForFile = createFilePolicyResolver(duplicationConfig, {
      files: new Map(),
      isEmpty: true,
      containsAddedLine: () => false,
    });
    const duplicateResult: CheckResult = {
      checkId: "duplication",
      status: "completed",
      durationMs: 4,
      findings: [
        {
          ...finding(true, "error", "generated/copy.ts"),
          id: "generated-duplicate",
          check: "duplication",
          rule: "duplicate-fragment",
        },
        {
          ...finding(true, "error", "src/maintained.ts"),
          id: "maintained-duplicate",
          check: "duplication",
          rule: "duplicate-fragment",
        },
      ],
    };

    const decision = evaluatePolicy(
      [
        {
          result: duplicateResult,
          policy: duplicationConfig.checks.duplication,
          policyForFile,
        },
      ],
      duplicationConfig,
    );

    expect(decision.results[0]?.findings.map(({ id }) => id)).toEqual([
      "maintained-duplicate",
    ]);
  });

  it("returns incomplete ahead of an ordinary policy block by default", () => {
    expect(
      evaluatePolicy(
        [execution(completed([finding(true)])), execution(incomplete)],
        config("error"),
      ),
    ).toMatchObject({
      exitCode: 2,
      outcome: "incomplete",
      results: [
        expect.objectContaining({ status: "completed" }),
        expect.objectContaining({
          status: "incomplete",
          incompleteDisposition: "block",
        }),
      ],
    });
  });

  it("can report incomplete analysis without failing solely because of it", () => {
    expect(
      evaluatePolicy([execution(incomplete)], config("error", false)),
    ).toMatchObject({
      exitCode: 0,
      outcome: "pass",
      summary: { incomplete: 1 },
      results: [
        expect.objectContaining({
          status: "incomplete",
          incompleteDisposition: "warn",
        }),
      ],
    });
  });

  it("blocks an explicitly blocking incomplete result even when the global default is open", () => {
    const decision = evaluatePolicy(
      [
        execution({
          ...incomplete,
          incompleteDisposition: "block",
        } as CheckResult),
      ],
      config("error", false),
    );

    expect(decision).toMatchObject({
      exitCode: 2,
      outcome: "incomplete",
      summary: { incomplete: 1 },
      results: [
        expect.objectContaining({
          status: "incomplete",
          incompleteDisposition: "block",
        }),
      ],
    });
  });

  it("keeps an explicitly non-blocking incomplete result visible under a strict global default", () => {
    const decision = evaluatePolicy(
      [
        execution({
          ...incomplete,
          incompleteDisposition: "warn",
        } as CheckResult),
      ],
      config("error", true),
    );

    expect(decision).toMatchObject({
      exitCode: 0,
      outcome: "pass",
      summary: { passed: 0, warnings: 0, failed: 0, incomplete: 1 },
      results: [
        expect.objectContaining({
          status: "incomplete",
          incompleteDisposition: "warn",
        }),
      ],
    });
  });
});
