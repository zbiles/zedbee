import { Linter } from "eslint";
import { afterEach, describe, expect, it, vi } from "vitest";
import { collectComplexityObservations } from "../../../src/checks/complexity/adapter.js";
import { managedConfig } from "../../../src/checks/eslint/managed-config.js";

afterEach(() => vi.restoreAllMocks());

describe("complexity source indexing", () => {
  const file = "src/lines.ts";
  const source = [
    "export function first(value: boolean) {",
    "  return value ? 1 : 0;",
    "}",
    "",
    "export function last(value: boolean) {",
    "  if (value) return 1;",
    "  return 0;",
    "}",
  ].join("\r\n");

  function messages() {
    return new Linter({ configType: "flat" }).verify(
      source,
      [...managedConfig({ mode: "complexity", managedIgnores: [] })],
      { filename: file },
    );
  }

  it("uses the closest following entity on the same line when no span contains the message", async () => {
    vi.spyOn(Linter.prototype, "verify").mockReturnValue([
      {
        ruleId: "complexity",
        severity: 2,
        message: "Arrow function has a complexity of 2.",
        line: 2,
        column: 1,
      },
    ]);

    await expect(
      collectComplexityObservations(
        file,
        "// leading line\r\nconst first = () => ready ? 1 : 0; const last = () => 0;",
      ),
    ).resolves.toEqual([
      {
        check: "cyclomaticComplexity",
        rule: "cyclomatic-complexity",
        identity: "function:src/lines.ts:first",
        severity: "error",
        message: "Cyclomatic complexity metric.",
        entity: { kind: "function", name: "first", file },
        metric: { name: "cyclomatic-complexity", value: 2 },
      },
    ]);
  });

  it("does not fall through to an entity on a later line", async () => {
    vi.spyOn(Linter.prototype, "verify").mockReturnValue([
      {
        ruleId: "complexity",
        severity: 2,
        message: "Arrow function has a complexity of 2.",
        line: 1,
        column: 1,
      },
    ]);

    await expect(
      collectComplexityObservations(
        file,
        "// leading line\r\nconst first = () => ready ? 1 : 0;",
      ),
    ).rejects.toThrow("Complexity metric had no canonical syntax entity.");
  });

  it("selects innermost functions and retains the maximum class-field metric", async () => {
    const observations = await collectComplexityObservations(
      file,
      [
        "function outer() {",
        "  const inner = (value: boolean) => value ? 1 : 0;",
        "  return inner;",
        "}",
        "class Worker {",
        "  task = () => ready ? 1 : 0;",
        "  task = () => { if (ready) { if (done) return 1; } return 0; };",
        "}",
      ].join("\r\n"),
      5,
    );

    for (const check of ["cyclomaticComplexity", "readabilityComplexity"]) {
      const metrics = observations.filter(
        (observation) => observation.check === check,
      );
      expect(metrics).toHaveLength(4);
      expect(
        metrics.find(({ entity }) => entity?.name === "inner"),
      ).toMatchObject({
        identity: "function:src/lines.ts:function=outer/function=inner",
        metric: { value: check === "cyclomaticComplexity" ? 2 : 1, limit: 5 },
      });
      expect(
        metrics.find(({ entity }) => entity?.name === "outer"),
      ).toMatchObject({
        identity: "function:src/lines.ts:outer",
        metric: { value: check === "cyclomaticComplexity" ? 1 : 0, limit: 5 },
      });
      const fields = metrics.filter(({ entity }) => entity?.name === "task");
      expect(fields.map(({ metric }) => metric?.value)).toEqual(
        check === "cyclomaticComplexity" ? [2, 3] : [1, 3],
      );
      expect(new Set(fields.map(({ identity }) => identity)).size).toBe(2);
    }
  });

  it("does not rescan line offsets as the number of metrics grows", async () => {
    const allMessages = messages();
    expect(allMessages).toHaveLength(4);
    const verify = vi
      .spyOn(Linter.prototype, "verify")
      .mockReturnValue(allMessages.slice(0, 1));
    const original = String.prototype.charCodeAt;
    let sourceReads = 0;
    vi.spyOn(String.prototype, "charCodeAt").mockImplementation(function (
      this: string,
      index,
    ) {
      if (String(this) === source) sourceReads += 1;
      return original.call(this, index);
    });

    await collectComplexityObservations(file, source, 5);
    const oneMetricReads = sourceReads;
    sourceReads = 0;
    verify.mockReturnValue(allMessages);
    const observations = await collectComplexityObservations(file, source, 5);
    const fourMetricReads = sourceReads;

    expect(observations).toHaveLength(4);
    expect(fourMetricReads).toBe(oneMetricReads);
  });

  it("skips following-span source slices when messages have a containing entity", async () => {
    const allMessages = messages();
    const verify = vi.spyOn(Linter.prototype, "verify").mockReturnValue([]);
    const original = String.prototype.slice;
    let sourceSlices = 0;
    vi.spyOn(String.prototype, "slice").mockImplementation(function (
      this: string,
      start,
      end,
    ) {
      if (String(this) === source) sourceSlices += 1;
      return original.call(this, start, end);
    });
    await collectComplexityObservations(file, source, 5);
    const parsingSlices = sourceSlices;
    sourceSlices = 0;
    verify.mockReturnValue(allMessages);
    const observations = await collectComplexityObservations(file, source, 5);
    const metricSlices = sourceSlices;

    expect(observations).toEqual([
      {
        check: "cyclomaticComplexity",
        rule: "cyclomatic-complexity",
        identity: "function:src/lines.ts:first",
        severity: "error",
        message: "Cyclomatic complexity metric.",
        entity: { kind: "function", name: "first", file },
        metric: { name: "cyclomatic-complexity", value: 2, limit: 5 },
      },
      {
        check: "readabilityComplexity",
        rule: "readability-complexity",
        identity: "function:src/lines.ts:first",
        severity: "error",
        message: "Readability complexity metric.",
        entity: { kind: "function", name: "first", file },
        metric: { name: "readability-complexity", value: 1, limit: 5 },
      },
      {
        check: "cyclomaticComplexity",
        rule: "cyclomatic-complexity",
        identity: "function:src/lines.ts:last",
        severity: "error",
        message: "Cyclomatic complexity metric.",
        entity: { kind: "function", name: "last", file },
        metric: { name: "cyclomatic-complexity", value: 2, limit: 5 },
      },
      {
        check: "readabilityComplexity",
        rule: "readability-complexity",
        identity: "function:src/lines.ts:last",
        severity: "error",
        message: "Readability complexity metric.",
        entity: { kind: "function", name: "last", file },
        metric: { name: "readability-complexity", value: 1, limit: 5 },
      },
    ]);
    expect(metricSlices).toBe(parsingSlices);
  });
});
