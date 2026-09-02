import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  cloneIdentity,
  cloneObservations,
  normalizeClone,
  parseJscpdReport,
} from "../../../src/checks/duplication/normalize-clone.js";
import type {
  JscpdClone,
  NormalizedCloneFragment,
} from "../../../src/checks/duplication/types.js";

function rawClone(overrides: Partial<JscpdClone> = {}): JscpdClone {
  return {
    firstFile: {
      name: "src/a.ts",
      start: 1,
      end: 6,
      startLoc: { line: 1, column: 0, position: 0 },
      endLoc: { line: 6, column: 1, position: 100 },
    },
    secondFile: {
      name: "src/b.ts",
      start: 2,
      end: 7,
      startLoc: { line: 2, column: 0, position: 10 },
      endLoc: { line: 7, column: 1, position: 110 },
    },
    fragment:
      "function first(value) { const result = value + 1; return result; }",
    lines: 6,
    tokens: 30,
    format: "typescript",
    ...overrides,
  };
}

describe("clone normalization", () => {
  it("gives an unordered fragment pair one stable identity", () => {
    const left: NormalizedCloneFragment = {
      file: "src/a.ts",
      startLine: 1,
      endLine: 6,
    };
    const right: NormalizedCloneFragment = {
      file: "src/b.ts",
      startLine: 2,
      endLine: 7,
    };
    const hash = "a".repeat(64);

    expect(cloneIdentity(left, right, hash)).toBe(
      cloneIdentity(right, left, hash),
    );
  });

  it("normalizes Windows separators and identifier-renamed clone tokens", () => {
    const first = normalizeClone(rawClone(), "/snapshot", "packages/app");
    const second = normalizeClone(
      rawClone({
        firstFile: { ...rawClone().firstFile, name: "src\\a.ts" },
        secondFile: { ...rawClone().secondFile, name: "src\\b.ts" },
        fragment:
          "function renamed(input) { const output = input + 1; return output; }",
      }),
      "/snapshot",
      "packages/app",
    );

    expect(second.fragments.map(({ file }) => file)).toEqual([
      "packages/app/src/a.ts",
      "packages/app/src/b.ts",
    ]);
    expect(second.tokenHash).toBe(first.tokenHash);
    expect(second.identity).toBe(first.identity);
  });

  it("emits one range observation per fragment only above density policy", () => {
    const report = parseJscpdReport(
      {
        duplicates: [rawClone()],
        statistics: {
          total: { percentage: 12, percentageTokens: 15 },
        },
      },
      "/snapshot",
      ".",
    );

    expect(cloneObservations(report, 12)).toEqual([]);
    expect(cloneObservations(report, 5)).toEqual([
      expect.objectContaining({
        identity: expect.stringMatching(/\/fragment=1$/u),
        location: expect.objectContaining({ file: "src/a.ts" }),
      }),
      expect.objectContaining({
        identity: expect.stringMatching(/\/fragment=2$/u),
        location: expect.objectContaining({ file: "src/b.ts" }),
      }),
    ]);
  });

  it.each(["/outside/src/a.ts", "/snapshot-other/src/a.ts"])(
    "rejects an absolute clone path outside the snapshot: %s",
    (name) => {
      expect(() =>
        normalizeClone(
          rawClone({ firstFile: { ...rawClone().firstFile, name } }),
          "/snapshot",
          ".",
          ["src/a.ts", "src/b.ts"],
        ),
      ).toThrow("Expected a normalized repository-relative path");
    },
  );

  it("accepts an absolute clone path when the snapshot root uses a filesystem alias", async () => {
    const parent = await mkdtemp(join(tmpdir(), "zedbee-clone-alias-"));
    onTestFinished(() => rm(parent, { recursive: true, force: true }));
    const canonicalRoot = join(parent, "canonical");
    const aliasRoot = join(parent, "alias");
    await mkdir(join(canonicalRoot, "src"), { recursive: true });
    await writeFile(
      join(canonicalRoot, "src", "a.ts"),
      "export const a = 1;\n",
    );
    await writeFile(
      join(canonicalRoot, "src", "b.ts"),
      "export const b = 2;\n",
    );
    await symlink(
      canonicalRoot,
      aliasRoot,
      process.platform === "win32" ? "junction" : "dir",
    );

    const clone = normalizeClone(
      rawClone({
        firstFile: {
          ...rawClone().firstFile,
          name: join(canonicalRoot, "src", "a.ts"),
        },
        secondFile: {
          ...rawClone().secondFile,
          name: join(canonicalRoot, "src", "b.ts"),
        },
      }),
      aliasRoot,
      ".",
      ["src/a.ts", "src/b.ts"],
    );

    expect(clone.fragments.map(({ file }) => file)).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it.each([
    null,
    {},
    { duplicates: [], statistics: { total: { percentage: 101 } } },
    {
      duplicates: [{ ...rawClone(), tokens: 0 }],
      statistics: { total: { percentage: 1 } },
    },
    {
      duplicates: [{ ...rawClone(), fragment: "" }],
      statistics: { total: { percentage: 1 } },
    },
  ])("fails closed on malformed report %#", (input) => {
    expect(() => parseJscpdReport(input, "/snapshot", ".")).toThrow();
  });

  it("changes identity when a clone is enlarged", () => {
    const baseline = normalizeClone(rawClone(), "/snapshot", ".");
    const target = normalizeClone(
      rawClone({
        fragment: `${rawClone().fragment} work();`,
        tokens: 32,
        firstFile: {
          ...rawClone().firstFile,
          endLoc: { line: 7, column: 1, position: 110 },
        },
      }),
      "/snapshot",
      ".",
    );

    expect(target.identity).not.toBe(baseline.identity);
    expect(target.tokens).toBeGreaterThan(baseline.tokens);
  });

  it("uses a trusted source-range hash when jscpd omits clone text", () => {
    const sourceRangeHash = "a".repeat(64);
    const normalizeWithFallback = normalizeClone as unknown as (
      clone: JscpdClone,
      snapshotRoot: string,
      workspaceRoot: string,
      sourceFiles: readonly string[],
      fallbackTokenHash: string,
    ) => ReturnType<typeof normalizeClone>;

    const normalized = normalizeWithFallback(
      rawClone({ fragment: "" }),
      "/snapshot",
      ".",
      ["src/a.ts", "src/b.ts"],
      sourceRangeHash,
    );

    expect(normalized.tokenHash).toBe(sourceRangeHash);
    expect(normalized.identity).toMatch(/^clone:[a-f0-9]{64}$/u);
  });

  it("applies source-range hashes by clone index when parsing a report", () => {
    const sourceRangeHash = "b".repeat(64);
    const parseWithFallback = parseJscpdReport as unknown as (
      input: unknown,
      snapshotRoot: string,
      workspaceRoot: string,
      sourceFiles: readonly string[],
      fallbackTokenHashes: ReadonlyMap<number, string>,
    ) => ReturnType<typeof parseJscpdReport>;

    const report = parseWithFallback(
      {
        duplicates: [rawClone({ fragment: "" })],
        statistics: { total: { percentage: 12, percentageTokens: 15 } },
      },
      "/snapshot",
      ".",
      ["src/a.ts", "src/b.ts"],
      new Map([[0, sourceRangeHash]]),
    );

    expect(report.clones[0]?.tokenHash).toBe(sourceRangeHash);
  });
});
