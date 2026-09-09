import { relative, sep } from "node:path";
import type { ESLint, Linter } from "eslint";
import { fingerprintObservation } from "../attribution/fingerprint.js";
import type { CheckRunContext } from "../checks/adapter.js";
import { convertEslintMessage } from "../checks/eslint/convert-message.js";
import { compareCodeUnits } from "../core/compare.js";
import type { Finding } from "../core/types.js";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
} from "../inspection/read-json.js";
import { captureSnapshotRegistry } from "../inspection/snapshot-registry.js";
import { capturedSourceRegistry } from "../inspection/source-capture.js";
import { sanitizeFixCandidates } from "./sanitize.js";
import type { ExactFileFixCandidate } from "./types.js";

export interface ManagedEslintFixInput {
  readonly context: CheckRunContext;
  readonly checkId: "lint" | "reactCorrectness";
  readonly files: readonly string[];
  createEngine(files: readonly string[]): Pick<ESLint, "lintFiles">;
}

interface ExactFix {
  readonly start: number;
  readonly end: number;
  readonly replacement: string;
}

function ownData(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !("value" in descriptor)) return undefined;
  return descriptor.value;
}

function validOffset(value: unknown, sourceLength: number): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= sourceLength
  );
}

function exactFix(
  message: Linter.LintMessage,
  sourceLength: number,
): ExactFix | undefined {
  const value = ownData(message, "fix");
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const range = ownData(value, "range");
  const replacement = ownData(value, "text");
  if (
    !Array.isArray(range) ||
    range.length !== 2 ||
    typeof replacement !== "string"
  ) {
    return undefined;
  }
  const start = ownData(range, "0");
  const end = ownData(range, "1");
  if (
    !validOffset(start, sourceLength) ||
    !validOffset(end, sourceLength) ||
    end < start
  ) {
    return undefined;
  }
  return { start, end, replacement };
}

function selectedFindings(
  findings: readonly Finding[],
  checkId: ManagedEslintFixInput["checkId"],
): ReadonlyMap<string, Finding> {
  const selected = new Map<string, Finding>();
  for (const finding of findings) {
    if (finding.check !== checkId) continue;
    if (selected.has(finding.id)) {
      throw new TypeError("Expected selected findings to have unique IDs");
    }
    selected.set(finding.id, finding);
  }
  return selected;
}

function sourcePath(root: string, absolutePath: string): string {
  return relative(root, absolutePath).split(sep).join("/");
}

/**
 * Re-runs a managed ESLint group against only the target snapshot and preserves
 * only exact official ESLint fixes that correlate to current attributed findings.
 */
export async function planManagedEslintFixes(
  input: ManagedEslintFixInput,
  findings: readonly Finding[],
): Promise<readonly ExactFileFixCandidate[]> {
  const { context, checkId } = input;
  context.signal.throwIfAborted();
  const canonicalRoot = await canonicalizeSnapshotRoot(
    context.snapshots.targetDir,
  );
  if (canonicalRoot !== context.targetInspection.snapshotRoot) {
    throw new Error("Managed ESLint fix planning failed.");
  }
  const files = [...new Set(input.files)].sort(compareCodeUnits);
  if (files.length === 0) return Object.freeze([]);
  const allowed = new Set(files);
  const registry =
    capturedSourceRegistry(canonicalRoot, files) ??
    (await captureSnapshotRegistry(canonicalRoot));
  const reported = selectedFindings(findings, checkId);
  const sources = new Map<string, Promise<string>>();
  const sourceFor = (file: string): Promise<string> => {
    let source = sources.get(file);
    if (source === undefined) {
      source = readContainedFile(registry, file);
      sources.set(file, source);
    }
    return source;
  };
  const edits = new Map<
    string,
    {
      readonly source: string;
      readonly edits: {
        readonly findingId: string;
        readonly severity: "warning" | "error";
        readonly start: number;
        readonly end: number;
        readonly replacement: string;
      }[];
    }
  >();
  const engine = input.createEngine(Object.freeze(files));
  const results = await engine.lintFiles(files);
  context.signal.throwIfAborted();
  for (const result of results) {
    context.signal.throwIfAborted();
    const file = sourcePath(canonicalRoot, result.filePath);
    if (!allowed.has(file)) {
      throw new TypeError("ESLint returned an unrequested file");
    }
    if (!Array.isArray(result.messages)) {
      throw new TypeError("ESLint returned invalid message metadata");
    }
    const source = await sourceFor(file);
    for (const message of result.messages) {
      const observation = convertEslintMessage(
        file,
        message,
        canonicalRoot,
        checkId,
      );
      const findingId = fingerprintObservation(observation);
      const finding = reported.get(findingId);
      if (
        finding === undefined ||
        finding.rule !== observation.rule ||
        (finding.severity !== "warning" && finding.severity !== "error")
      ) {
        continue;
      }
      const fix = exactFix(message, source.length);
      if (fix === undefined) continue;
      const candidate = edits.get(file);
      if (candidate === undefined) {
        edits.set(file, {
          source,
          edits: [
            {
              findingId,
              severity: finding.severity,
              ...fix,
            },
          ],
        });
      } else {
        candidate.edits.push({
          findingId,
          severity: finding.severity,
          ...fix,
        });
      }
    }
  }
  const candidates = sanitizeFixCandidates(
    [...edits.entries()]
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([file, candidate]) => ({
        kind: "exact-file" as const,
        checkId,
        file,
        baseSource: candidate.source,
        edits: candidate.edits,
      })),
    {
      checkId,
      findingIds: [...reported.keys()],
    },
  );
  return Object.freeze(
    candidates.map((candidate) => {
      if (candidate.kind !== "exact-file") {
        throw new TypeError("Expected an exact-file ESLint fix candidate");
      }
      return candidate;
    }),
  );
}
