import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import type {
  CheckResult,
  Finding,
  SourceLocation,
} from "../../src/core/types.js";

const containedFileReads = vi.hoisted(() => [] as string[]);

vi.mock("../../src/inspection/read-json.js", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../src/inspection/read-json.js")>();
  return {
    ...original,
    async readContainedFile(
      ...args: Parameters<typeof original.readContainedFile>
    ) {
      containedFileReads.push(args[1]);
      return original.readContainedFile(...args);
    },
  };
});

import { shouldIncludeSourceExcerpts } from "../../src/scan/reporting-options.js";
import { enrichSourceExcerpts } from "../../src/scan/source-excerpts.js";

function finding(
  overrides: Omit<Partial<Finding>, "location"> & {
    location?: SourceLocation | undefined;
  } = {},
): Finding {
  const base: Finding = {
    id: "lint:src/value.ts:4",
    check: "lint",
    rule: "no-debugger",
    severity: "error",
    message: "Remove debugger.",
    location: { file: "src/value.ts", startLine: 4 },
    attribution: {
      kind: "range-overlap",
      staged: true,
      evidence: ["src/value.ts:4"],
    },
  };
  const merged = { ...base, ...overrides };
  if (
    Object.prototype.hasOwnProperty.call(overrides, "location") &&
    overrides.location === undefined
  ) {
    const { location: _location, ...withoutLocation } = merged;
    return withoutLocation as Finding;
  }
  return merged as Finding;
}

function completed(findings: readonly Finding[]): CheckResult {
  return {
    checkId: "lint",
    status: "completed",
    durationMs: 1,
    findings,
  };
}

async function sourceSnapshot(contents: string): Promise<string> {
  const created = await mkdtemp(join(tmpdir(), "zedbee-excerpts-"));
  const snapshotRoot = await realpath(created);
  onTestFinished(() => rm(snapshotRoot, { recursive: true }));
  await mkdir(join(snapshotRoot, "src"));
  await writeFile(join(snapshotRoot, "src/value.ts"), contents);
  return snapshotRoot;
}

describe("shouldIncludeSourceExcerpts", () => {
  it.each([
    ["never", "ink", undefined, false],
    ["interactive", "ink", undefined, true],
    ["interactive", "text", undefined, false],
    ["interactive", "json", undefined, false],
    ["always", "text", undefined, true],
    ["never", "json", "include", true],
    ["always", "ink", "exclude", false],
  ] as const)("resolves %s/%s/%s", (policy, surface, override, expected) => {
    expect(shouldIncludeSourceExcerpts(policy, surface, override)).toBe(
      expected,
    );
  });

  it.each([undefined, "include", "exclude"] as const)(
    "omits excerpts for library calls without a reporting surface (%s)",
    (override) => {
      expect(shouldIncludeSourceExcerpts("always", undefined, override)).toBe(
        false,
      );
    },
  );
});

describe("enrichSourceExcerpts", () => {
  it("normalizes tabs and terminal controls on the selected source line", async () => {
    const snapshotRoot = await sourceSnapshot(
      "one\ntwo\nthree\n\tconst value = 1;\u001b\u0085\n",
    );

    const [result] = await enrichSourceExcerpts([completed([finding()])], {
      snapshotRoot,
    });

    expect(result?.findings[0]?.sourceExcerpt).toEqual({
      line: 4,
      text: "  const value = 1;��",
      redacted: false,
      truncated: false,
    });
  });

  it("splits every JavaScript source line ending", async () => {
    const snapshotRoot = await sourceSnapshot(
      "one\r\ntwo\rthree\nfour\u2028five\u2029six",
    );
    const findings = [1, 2, 3, 4, 5, 6].map((line) =>
      finding({
        id: `lint:src/value.ts:${line}`,
        location: { file: "src/value.ts", startLine: line },
      }),
    );

    const [result] = await enrichSourceExcerpts([completed(findings)], {
      snapshotRoot,
    });

    expect(
      result?.findings.map(({ sourceExcerpt }) => sourceExcerpt?.text),
    ).toEqual(["one", "two", "three", "four", "five", "six"]);
  });

  it("caps excerpts at 500 Unicode code points with a final ellipsis", async () => {
    const snapshotRoot = await sourceSnapshot(
      `one\ntwo\nthree\n${"🙂".repeat(501)}\n`,
    );

    const [result] = await enrichSourceExcerpts([completed([finding()])], {
      snapshotRoot,
    });
    const excerpt = result?.findings[0]?.sourceExcerpt;

    expect(excerpt).toEqual({
      line: 4,
      text: `${"🙂".repeat(499)}…`,
      redacted: false,
      truncated: true,
    });
    expect(Array.from(excerpt?.text ?? "")).toHaveLength(500);
  });

  it("omits unavailable and repository-level excerpts without changing findings", async () => {
    const snapshotRoot = await sourceSnapshot("export const value = 1;\n");
    const input = completed([
      finding({ id: "repository", location: undefined }),
      finding({
        id: "missing",
        location: { file: "src/missing.ts", startLine: 1 },
      }),
      finding({
        id: "out-of-range",
        location: { file: "src/value.ts", startLine: 9 },
      }),
    ]);

    const [result] = await enrichSourceExcerpts([input], { snapshotRoot });

    expect(result?.findings.map(({ id }) => id)).toEqual([
      "repository",
      "missing",
      "out-of-range",
    ]);
    expect(
      result?.findings.every(
        ({ sourceExcerpt }) => sourceExcerpt === undefined,
      ),
    ).toBe(true);
    expect(result).not.toBe(input);
    expect(result?.findings[0]).not.toBe(input.findings[0]);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result?.findings)).toBe(true);
    expect(Object.isFrozen(result?.findings[0])).toBe(true);
  });

  it("preserves the public check field order while copying results", async () => {
    const snapshotRoot = await sourceSnapshot("export const value = 1;\n");
    const input: CheckResult = {
      checkId: "lint",
      target: "workspace",
      status: "incomplete",
      durationMs: 1,
      findings: [
        finding({
          id: "lint:src/value.ts:1",
          location: { file: "src/value.ts", startLine: 1 },
        }),
      ],
      error: { code: "LINT_FAILED", message: "Lint failed." },
    };

    const [result] = await enrichSourceExcerpts([input], { snapshotRoot });

    expect(Object.keys(result ?? {})).toEqual([
      "checkId",
      "target",
      "status",
      "durationMs",
      "findings",
      "error",
    ]);
    expect(Object.keys(result?.findings[0] ?? {})).toEqual([
      "id",
      "check",
      "rule",
      "severity",
      "message",
      "location",
      "sourceExcerpt",
      "attribution",
    ]);
  });

  it("redacts secret findings without invoking the source reader", async () => {
    containedFileReads.length = 0;
    const snapshotRoot = await sourceSnapshot(
      "one\ntwo\nthree\nSECRET-MUST-NOT-LEAK\n",
    );
    const secret = finding({
      id: "secret:src/value.ts:4",
      check: "secrets",
      rule: "generic-api-key",
      message: "A secret was detected.",
    });

    const results = await enrichSourceExcerpts([completed([secret])], {
      snapshotRoot,
    });

    expect(results[0]?.findings[0]?.sourceExcerpt).toEqual({
      line: 4,
      redacted: true,
      truncated: false,
    });
    expect(containedFileReads).toEqual([]);
    expect(JSON.stringify(results)).not.toContain("SECRET-MUST-NOT-LEAK");
  });
});
