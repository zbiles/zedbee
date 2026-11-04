import { diffChars } from "diff";
import type { ExactFixEdit } from "./types.js";

export function exactFixesOverlap(
  left: ExactFixEdit,
  right: ExactFixEdit,
): boolean {
  if (left.start === left.end && right.start === right.end)
    return left.start === right.start;
  if (left.start === left.end)
    return left.start > right.start && left.start < right.end;
  if (right.start === right.end)
    return right.start > left.start && right.start < left.end;
  return left.start < right.end && right.start < left.end;
}

/** Marks every participating edit in O(E log E), including duplicate insertions. */
export function overlappingExactEdits(
  edits: readonly ExactFixEdit[],
): ReadonlySet<ExactFixEdit> {
  const conflicts = new Set<ExactFixEdit>();
  let longest: ExactFixEdit | undefined;
  let insertion: ExactFixEdit | undefined;
  for (const edit of [...edits].sort(
    (a, b) => a.start - b.start || a.end - b.end,
  )) {
    if (edit.start === edit.end) {
      if (insertion?.start === edit.start) {
        conflicts.add(insertion);
        conflicts.add(edit);
      }
      insertion = edit;
      if (longest !== undefined && exactFixesOverlap(longest, edit)) {
        conflicts.add(longest);
        conflicts.add(edit);
      }
    } else {
      if (longest !== undefined && longest.end > edit.start) {
        conflicts.add(longest);
        conflicts.add(edit);
      }
      if (longest === undefined || edit.end > longest.end) longest = edit;
    }
  }
  return conflicts;
}

interface Span {
  readonly start: number;
  readonly end: number;
  readonly working: number;
}
export interface ExactEditMapping {
  mapEdit(
    edit: ExactFixEdit,
  ): Readonly<{ start: number; end: number }> | undefined;
}

/** First index for which the monotone predicate holds. */
function lowerBound<T>(
  values: readonly T[],
  predicate: (value: T) => boolean,
): number {
  let low = 0;
  let high = values.length;
  while (low < high) {
    const middle = low + Math.floor((high - low) / 2);
    if (predicate(values[middle]!)) high = middle;
    else low = middle + 1;
  }
  return low;
}

/** One diff and compact unchanged spans per file; no edited text is built while planning. */
export function createExactEditMapping(
  base: string,
  working: string,
): ExactEditMapping | undefined {
  const components =
    base === working
      ? [{ value: base }]
      : diffChars(base, working, { timeout: 1_000 });
  if (components === undefined) return undefined;
  const spans: Span[] = [];
  const removals: { start: number; end: number }[] = [];
  const additions: number[] = [];
  let baseOffset = 0;
  let workingOffset = 0;
  for (const component of components) {
    const length = component.value.length;
    if ("added" in component && component.added) {
      additions.push(baseOffset);
      workingOffset += length;
    } else if ("removed" in component && component.removed) {
      removals.push({ start: baseOffset, end: baseOffset + length });
      baseOffset += length;
    } else {
      spans.push({
        start: baseOffset,
        end: baseOffset + length,
        working: workingOffset,
      });
      baseOffset += length;
      workingOffset += length;
    }
  }
  const characterOffset = (position: number): number | undefined => {
    const span = spans[lowerBound(spans, (span) => span.end > position)];
    return span !== undefined && span.start <= position
      ? span.working + position - span.start
      : undefined;
  };
  return Object.freeze({
    mapEdit(edit: ExactFixEdit) {
      const insertion = edit.start === edit.end;
      const removed =
        removals[
          lowerBound(removals, (span) =>
            insertion ? span.end >= edit.start : span.end > edit.start,
          )
        ];
      if (
        removed !== undefined &&
        (insertion ? removed.start <= edit.start : removed.start < edit.end)
      )
        return undefined;
      const added =
        additions[
          lowerBound(additions, (position) =>
            insertion ? position >= edit.start : position > edit.start,
          )
        ];
      if (
        added !== undefined &&
        (insertion ? added === edit.start : added < edit.end)
      )
        return undefined;
      const start =
        characterOffset(edit.start) ??
        (insertion && edit.start === base.length ? working.length : undefined);
      const last = insertion ? start : characterOffset(edit.end - 1);
      if (start === undefined || last === undefined) return undefined;
      return Object.freeze({ start, end: insertion ? start : last + 1 });
    },
  });
}

/** Maps base UTF-16 offsets to working UTF-16 offsets, constructing text only at apply. */
export function composeExactFixes(
  base: string,
  working: string,
  edits: readonly ExactFixEdit[],
): string | undefined {
  const mapping = createExactEditMapping(base, working);
  if (mapping === undefined) return undefined;
  let merged = working;
  for (const edit of [...edits].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  )) {
    const offsets = mapping.mapEdit(edit);
    if (offsets === undefined) return undefined;
    merged = `${merged.slice(0, offsets.start)}${edit.replacement}${merged.slice(offsets.end)}`;
  }
  return merged;
}
