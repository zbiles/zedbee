import { diffChars } from "diff";
import type { ExactFixEdit } from "./types.js";

export function exactFixesOverlap(
  left: ExactFixEdit,
  right: ExactFixEdit,
): boolean {
  if (left.start === left.end && right.start === right.end) {
    return left.start === right.start;
  }
  if (left.start === left.end) {
    return left.start > right.start && left.start < right.end;
  }
  if (right.start === right.end) {
    return right.start > left.start && right.start < left.end;
  }
  return left.start < right.end && right.start < left.end;
}

/** Maps base UTF-16 offsets to current working UTF-16 offsets without text search. */
export function composeExactFixes(
  base: string,
  working: string,
  edits: readonly ExactFixEdit[],
): string | undefined {
  const baseToWorking = new Array<number>(base.length + 1);
  const baseCharacterToWorking = new Array<number>(base.length);
  let baseOffset = 0;
  let workingOffset = 0;
  baseToWorking[0] = 0;
  for (const component of diffChars(base, working)) {
    const length = component.value.length;
    if (component.added) {
      const intersects = edits.some((edit) =>
        edit.start === edit.end
          ? edit.start === baseOffset
          : edit.start < baseOffset && baseOffset < edit.end,
      );
      if (intersects) return undefined;
      workingOffset += length;
      continue;
    }
    if (component.removed) {
      const end = baseOffset + length;
      if (
        edits.some((edit) =>
          edit.start === edit.end
            ? baseOffset <= edit.start && edit.start <= end
            : edit.start < end && baseOffset < edit.end,
        )
      ) {
        return undefined;
      }
      baseOffset = end;
      continue;
    }
    for (let offset = 0; offset < length; offset += 1) {
      baseToWorking[baseOffset + offset] = workingOffset + offset;
      baseCharacterToWorking[baseOffset + offset] = workingOffset + offset;
    }
    baseOffset += length;
    workingOffset += length;
    baseToWorking[baseOffset] = workingOffset;
  }
  if (baseOffset !== base.length) return undefined;
  let merged = working;
  for (const edit of [...edits].sort(
    (left, right) => right.start - left.start || right.end - left.end,
  )) {
    const start =
      edit.start === edit.end
        ? baseToWorking[edit.start]
        : baseCharacterToWorking[edit.start];
    const end =
      edit.start === edit.end
        ? start
        : (() => {
            const lastCharacter = baseCharacterToWorking[edit.end - 1];
            return lastCharacter === undefined ? undefined : lastCharacter + 1;
          })();
    if (start === undefined || end === undefined) return undefined;
    merged = `${merged.slice(0, start)}${edit.replacement}${merged.slice(end)}`;
  }
  return merged;
}
