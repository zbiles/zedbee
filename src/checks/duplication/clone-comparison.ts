import { createHash } from "node:crypto";
import type { Observation } from "../../core/types.js";
import type { ChangeSet } from "../../git/change-set.js";
import type { CheckObservationSet } from "../adapter.js";
import { cloneObservations } from "./normalize-clone.js";
import type {
  NormalizedCloneFragment,
  NormalizedDuplicationReport,
} from "./types.js";
import type { DuplicationSourceIndex, SourceToken } from "./source-tokens.js";

function signature(tokens: readonly SourceToken[]): string {
  return JSON.stringify(tokens.map(({ kind, text }) => [kind, text]));
}
function occurrences(report: NormalizedDuplicationReport): Observation[] {
  const unique = new Map<string, Observation>();
  for (const observation of cloneObservations(
    { ...report, percentage: 100 },
    0,
  )) {
    const loc = observation.location as NormalizedCloneFragment;
    const key = JSON.stringify([
      loc.file,
      loc.startOffset ?? loc.startLine,
      loc.endOffset ?? loc.endLine,
    ]);
    if (!unique.has(key)) unique.set(key, observation);
  }
  return [...unique.values()];
}
function span(
  location: NormalizedCloneFragment,
  source: DuplicationSourceIndex,
): readonly SourceToken[] | undefined {
  const entry = source.get(location.file);
  if (!entry?.valid) return undefined;
  const tokens = entry.tokens;
  const lowerBound = (predicate: (token: SourceToken) => boolean): number => {
    let low = 0,
      high = tokens.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (predicate(tokens[mid]!)) high = mid;
      else low = mid + 1;
    }
    return low;
  };
  const start = lowerBound(
    location.startOffset === undefined
      ? (token) => token.line >= location.startLine
      : (token) => token.start >= location.startOffset!,
  );
  const end = lowerBound(
    location.endOffset === undefined
      ? (token) => token.line > location.endLine
      : (token) => token.end > location.endOffset!,
  );
  return end > start ? tokens.slice(start, end) : undefined;
}
export function compareCloneOccurrences(
  baseline: NormalizedDuplicationReport,
  target: NormalizedDuplicationReport,
  baselineSources: DuplicationSourceIndex,
  targetSources: DuplicationSourceIndex,
  changes: ChangeSet,
  threshold: number,
  mode = "mild",
): Pick<CheckObservationSet, "baselineObservations" | "targetObservations"> {
  if (target.percentage <= threshold)
    return { baselineObservations: [], targetObservations: [] };
  const old = occurrences(baseline);
  const next = occurrences(target);
  const previousPath = (file: string): string =>
    changes.files.get(file)?.previousPath ?? file;
  const unchanged =
    targetSources.size === baselineSources.size &&
    [...targetSources].every(([file, source]) => {
      const prior = baselineSources.get(previousPath(file));
      return (
        prior?.valid &&
        source.valid &&
        (mode === "mild"
          ? signature(prior.tokens) === signature(source.tokens)
          : prior.text === source.text)
      );
    });
  const canPair = baseline.percentage > threshold || unchanged;
  const used = new Set<number>();
  const oldIndexes = new Map(
    [...baselineSources].map(([file, source]) => [
      file,
      new Map(source.tokens.map((token, index) => [token, index])),
    ]),
  );
  const newIndexes = new Map(
    [...targetSources].map(([file, source]) => [
      file,
      new Map(source.tokens.map((token, index) => [token, index])),
    ]),
  );
  const oldOrdinals = new Map<string, number>();
  old.forEach((item, index) => {
    const loc = item.location as NormalizedCloneFragment;
    const tokens = span(loc, baselineSources);
    const source = baselineSources.get(loc.file);
    if (!tokens || !source) return;
    const key = JSON.stringify([loc.file, signature(tokens)]);
    oldOrdinals.set(
      JSON.stringify([key, oldIndexes.get(loc.file)!.get(tokens[0]!)!]),
      index,
    );
  });
  const fileEquality = new Map<string, boolean>();
  const continuity = new Map<string, { prefix: number; suffix: number }>();
  for (const [file, source] of targetSources) {
    const prior = baselineSources.get(previousPath(file));
    if (!source.valid || !prior?.valid) continue;
    const sameToken = (a: SourceToken, b: SourceToken): boolean =>
      a.kind === b.kind && a.text === b.text;
    let prefix = 0;
    while (
      prefix < source.tokens.length &&
      prefix < prior.tokens.length &&
      sameToken(source.tokens[prefix]!, prior.tokens[prefix]!)
    )
      prefix++;
    let suffix = 0;
    while (
      suffix < source.tokens.length - prefix &&
      suffix < prior.tokens.length - prefix &&
      sameToken(
        source.tokens[source.tokens.length - suffix - 1]!,
        prior.tokens[prior.tokens.length - suffix - 1]!,
      )
    )
      suffix++;
    continuity.set(file, { prefix, suffix });
    fileEquality.set(
      file,
      mode === "mild"
        ? prefix === source.tokens.length && prefix === prior.tokens.length
        : source.text === prior.text,
    );
  }
  const oldOutput: Observation[] =
    baseline.percentage > threshold ? [...old] : [];
  const newOutput: Observation[] = [];
  for (const item of next) {
    const loc = item.location as NormalizedCloneFragment;
    const tokens = span(loc, targetSources);
    const source = targetSources.get(loc.file);
    const prior = baselineSources.get(previousPath(loc.file));
    let fullEqual = fileEquality.get(loc.file);
    if (fullEqual === undefined) {
      fullEqual = Boolean(
        source?.valid &&
        prior?.valid &&
        (mode === "mild"
          ? signature(source.tokens) === signature(prior.tokens)
          : source.text === prior.text),
      );
      fileEquality.set(loc.file, fullEqual);
    }
    const addedSignificant =
      tokens?.some(({ line }) => changes.containsAddedLine(loc.file, line)) ??
      true;
    let candidates: number[] = [];
    const changed = changes.files.get(loc.file);
    const hasLineEvidence =
      changed === undefined || changed.addedRanges.length > 0;
    if (
      canPair &&
      tokens &&
      (fullEqual || (!addedSignificant && hasLineEvidence && mode === "mild"))
    ) {
      const key = JSON.stringify([previousPath(loc.file), signature(tokens)]);
      if (source && prior) {
        const ordinal = newIndexes.get(loc.file)!.get(tokens[0]!)!;
        const mapping = continuity.get(loc.file);
        let oldOrdinal: number | undefined;
        if (mapping && ordinal + tokens.length <= mapping.prefix)
          oldOrdinal = ordinal;
        else if (mapping && ordinal >= source.tokens.length - mapping.suffix)
          oldOrdinal = ordinal + prior.tokens.length - source.tokens.length;
        if (oldOrdinal !== undefined) {
          const index = oldOrdinals.get(JSON.stringify([key, oldOrdinal]));
          if (index !== undefined && !used.has(index)) candidates = [index];
        }
      }
    }
    if (candidates.length === 1) {
      const index = candidates[0]!;
      used.add(index);
      const key = `dup-occurrence:${createHash("sha256")
        .update(JSON.stringify([index, old[index]!.identity]))
        .digest("hex")}`;
      const pairedOld = { ...old[index]!, comparisonIdentity: key };
      if (baseline.percentage > threshold) oldOutput[index] = pairedOld;
      else oldOutput.push(pairedOld);
      newOutput.push({ ...item, comparisonIdentity: key });
    } else {
      newOutput.push({
        ...item,
        comparisonIdentity: `dup-target:${createHash("sha256").update(item.identity).digest("hex")}`,
      });
    }
  }
  return { baselineObservations: oldOutput, targetObservations: newOutput };
}
