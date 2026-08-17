import { diffLines } from "diff";
import { mergeLineRanges, type LineRange } from "../../git/change-set.js";

function lineCount(value: string, reportedCount: number | undefined): number {
  if (reportedCount !== undefined) {
    return reportedCount;
  }
  if (value === "") {
    return 0;
  }
  const breaks = value.match(/\n/g)?.length ?? 0;
  return breaks + (value.endsWith("\n") ? 0 : 1);
}

export function formattingTransformationRanges(
  source: string,
  formatted: string,
): LineRange[] {
  if (source === formatted) {
    return [];
  }

  const sourceLineCount = Math.max(1, lineCount(source, undefined));
  const changes = diffLines(source, formatted);
  const ranges: LineRange[] = [];
  let sourceLine = 1;
  let previousWasRemoval = false;

  for (const change of changes) {
    const count = lineCount(change.value, change.count);
    if (change.removed === true) {
      if (count > 0) {
        ranges.push({ start: sourceLine, end: sourceLine + count - 1 });
        sourceLine += count;
      }
      previousWasRemoval = true;
    } else if (change.added === true) {
      if (!previousWasRemoval) {
        const anchor = Math.min(Math.max(sourceLine, 1), sourceLineCount);
        ranges.push({ start: anchor, end: anchor });
      }
      previousWasRemoval = false;
    } else {
      sourceLine += count;
      previousWasRemoval = false;
    }
  }

  return mergeLineRanges(ranges);
}

export function intersectRanges(
  transformations: readonly LineRange[],
  staged: readonly LineRange[],
): LineRange[] {
  const intersections: LineRange[] = [];
  for (const transformation of transformations) {
    for (const changed of staged) {
      const start = Math.max(transformation.start, changed.start);
      const end = Math.min(transformation.end, changed.end);
      if (start <= end) {
        intersections.push({ start, end });
      }
    }
  }
  return mergeLineRanges(intersections);
}
