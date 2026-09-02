import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { basename, isAbsolute, posix, relative, resolve, sep } from "node:path";
import ts from "typescript";
import { compareCodeUnits } from "../../core/compare.js";
import type { Observation } from "../../core/types.js";
import { normalizeRepositoryRelativePath } from "../../attribution/fingerprint.js";
import type {
  JscpdClone,
  JscpdFileFragment,
  JscpdReport,
  NormalizedClone,
  NormalizedCloneFragment,
  NormalizedDuplicationReport,
} from "./types.js";

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected ${field} to be an object`);
  }
  return value as Record<string, unknown>;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError(`Expected ${field} to be a positive integer`);
  }
  return value as number;
}

function finitePercentage(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < 0 ||
    value > 100
  ) {
    throw new TypeError("Expected jscpd duplicate percentage");
  }
  return value;
}

function normalizedTokenHash(fragment: string): string {
  if (typeof fragment !== "string" || fragment.length === 0) {
    throw new TypeError("Expected a non-empty jscpd clone fragment");
  }
  const scanner = ts.createScanner(
    ts.ScriptTarget.Latest,
    true,
    ts.LanguageVariant.JSX,
    fragment,
  );
  const tokens: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken;) {
    tokens.push(String(token));
    token = scanner.scan();
  }
  if (tokens.length === 0) throw new TypeError("Expected clone tokens");
  return createHash("sha256").update(tokens.join(","), "utf8").digest("hex");
}

function reportedPath(
  name: unknown,
  snapshotRoot: string,
  workspaceRoot: string,
  sourceFiles: readonly string[],
): string {
  if (typeof name !== "string" || name.length === 0) {
    throw new TypeError("Expected a jscpd fragment path");
  }
  const portable = name.replaceAll("\\", "/");
  if (isAbsolute(name)) {
    const direct = relative(snapshotRoot, name).split(sep).join("/");
    try {
      return normalizeRepositoryRelativePath(direct);
    } catch (directError) {
      try {
        return normalizeRepositoryRelativePath(
          relative(realpathSync(snapshotRoot), realpathSync(name))
            .split(sep)
            .join("/"),
        );
      } catch {
        try {
          const reportedMetadata = statSync(name);
          const reportedBasename = basename(name).toLowerCase();
          for (const sourceFile of sourceFiles) {
            if (posix.basename(sourceFile).toLowerCase() !== reportedBasename) {
              continue;
            }
            const sourceMetadata = statSync(resolve(snapshotRoot, sourceFile));
            if (
              reportedMetadata.ino !== 0 &&
              reportedMetadata.dev === sourceMetadata.dev &&
              reportedMetadata.ino === sourceMetadata.ino
            ) {
              return sourceFile;
            }
          }
        } catch {
          // Invalid or missing paths still fail with the original boundary error.
        }
        throw directError;
      }
    }
  }
  const workspaceRelative = normalizeRepositoryRelativePath(portable);
  const direct = normalizeRepositoryRelativePath(
    workspaceRoot === "."
      ? workspaceRelative
      : posix.join(workspaceRoot, workspaceRelative),
  );
  if (sourceFiles.includes(direct)) return direct;
  const matches = sourceFiles.filter(
    (file) =>
      file === workspaceRelative || file.endsWith(`/${workspaceRelative}`),
  );
  return matches.length === 1 ? matches[0]! : direct;
}

export function normalizeCloneFragment(
  input: JscpdFileFragment,
  snapshotRoot: string,
  workspaceRoot: string,
  sourceFiles: readonly string[],
): NormalizedCloneFragment {
  const value = object(input, "jscpd fragment");
  const startLoc = object(value.startLoc, "jscpd start location");
  const endLoc = object(value.endLoc, "jscpd end location");
  const startLine = positiveInteger(startLoc.line, "jscpd start line");
  const endLine = positiveInteger(endLoc.line, "jscpd end line");
  if (endLine < startLine) throw new TypeError("Expected ordered clone lines");
  return Object.freeze({
    file: reportedPath(value.name, snapshotRoot, workspaceRoot, sourceFiles),
    startLine,
    endLine,
  });
}

function fragmentKey(value: NormalizedCloneFragment): string {
  return JSON.stringify([
    value.file,
    value.startLine,
    value.startColumn ?? null,
    value.endLine,
    value.endColumn ?? null,
  ]);
}

export function cloneIdentity(
  left: NormalizedCloneFragment,
  right: NormalizedCloneFragment,
  tokenHash: string,
): string {
  if (!/^[a-f0-9]{64}$/u.test(tokenHash)) {
    throw new TypeError("Expected a canonical clone token hash");
  }
  const fragments = [fragmentKey(left), fragmentKey(right)].sort(
    compareCodeUnits,
  );
  return `clone:${createHash("sha256")
    .update(JSON.stringify([fragments, tokenHash]), "utf8")
    .digest("hex")}`;
}

export function normalizeClone(
  raw: JscpdClone,
  snapshotRoot: string,
  workspaceRoot: string,
  sourceFiles: readonly string[] = [],
  fallbackTokenHash?: string,
): NormalizedClone {
  const value = object(raw, "jscpd clone");
  const tokens = positiveInteger(value.tokens, "jscpd clone tokens");
  const tokenHash =
    value.fragment === "" && /^[a-f0-9]{64}$/u.test(fallbackTokenHash ?? "")
      ? fallbackTokenHash!
      : normalizedTokenHash(value.fragment as string);
  const fragments = [
    normalizeCloneFragment(
      value.firstFile as unknown as JscpdFileFragment,
      snapshotRoot,
      workspaceRoot,
      sourceFiles,
    ),
    normalizeCloneFragment(
      value.secondFile as unknown as JscpdFileFragment,
      snapshotRoot,
      workspaceRoot,
      sourceFiles,
    ),
  ].sort((left, right) =>
    compareCodeUnits(fragmentKey(left), fragmentKey(right)),
  ) as [NormalizedCloneFragment, NormalizedCloneFragment];
  return Object.freeze({
    identity: cloneIdentity(fragments[0], fragments[1], tokenHash),
    tokenHash,
    tokens,
    fragments: Object.freeze(fragments),
  });
}

export function parseJscpdReport(
  raw: unknown,
  snapshotRoot: string,
  workspaceRoot: string,
  sourceFiles: readonly string[] = [],
  fallbackTokenHashes: ReadonlyMap<number, string> = new Map(),
): NormalizedDuplicationReport {
  const report = object(raw, "jscpd report") as unknown as JscpdReport;
  if (!Array.isArray(report.duplicates)) {
    throw new TypeError("Expected jscpd duplicates");
  }
  const statistics = object(report.statistics, "jscpd statistics");
  const total = object(statistics.total, "jscpd total statistics");
  const clones = report.duplicates
    .map((clone, index) =>
      normalizeClone(
        clone,
        snapshotRoot,
        workspaceRoot,
        sourceFiles,
        fallbackTokenHashes.get(index),
      ),
    )
    .sort((left, right) => compareCodeUnits(left.identity, right.identity));
  if (new Set(clones.map(({ identity }) => identity)).size !== clones.length) {
    throw new TypeError("Expected unique normalized jscpd clones");
  }
  return Object.freeze({
    percentage: finitePercentage(total.percentage),
    clones: Object.freeze(clones),
  });
}

export function missingCloneFragmentLocations(
  raw: unknown,
  snapshotRoot: string,
  workspaceRoot: string,
  sourceFiles: readonly string[],
): readonly Readonly<{
  index: number;
  location: NormalizedCloneFragment;
}>[] {
  const report = object(raw, "jscpd report");
  if (!Array.isArray(report.duplicates)) {
    throw new TypeError("Expected jscpd duplicates");
  }
  return Object.freeze(
    report.duplicates.flatMap((clone, index) => {
      const value = object(clone, "jscpd clone");
      if (value.fragment !== "") return [];
      return [
        Object.freeze({
          index,
          location: normalizeCloneFragment(
            value.firstFile as unknown as JscpdFileFragment,
            snapshotRoot,
            workspaceRoot,
            sourceFiles,
          ),
        }),
      ];
    }),
  );
}

export function cloneObservations(
  report: NormalizedDuplicationReport,
  threshold: number,
): readonly Observation[] {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new TypeError("Expected a duplication percentage threshold");
  }
  if (report.percentage <= threshold) return Object.freeze([]);
  return Object.freeze(
    report.clones.flatMap((clone) =>
      clone.fragments.map((location, index): Observation => ({
        check: "duplication",
        rule: "duplicate-fragment",
        identity: `${clone.identity}/fragment=${index + 1}`,
        severity: "error",
        message: "Duplicated code exceeds the configured project threshold.",
        location,
        remediation: "Extract shared logic or remove the duplicated fragment.",
      })),
    ),
  );
}
