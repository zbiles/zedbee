import {
  applyEdits,
  createScanner,
  findNodeAtLocation,
  modify,
  parse,
  parseTree,
} from "jsonc-parser";
import { isDeepStrictEqual } from "node:util";

function removeGeneratedOverride(source: string, index: number): string {
  const root = parseTree(source);
  if (root === undefined) return source;
  const entries = findNodeAtLocation(root, ["overrides"])?.children;
  const entry = entries?.[index];
  if (entry === undefined) return source;
  // Remove only the entry and its separator. Trivia between entries can
  // belong to a neighboring handwritten rule.
  const edits = [{ offset: entry.offset, length: entry.length, content: "" }];
  const scanner = createScanner(source, true);
  scanner.setPosition(entry.offset + entry.length);
  scanner.scan();
  if (source[scanner.getTokenOffset()] === ",") {
    edits.push({ offset: scanner.getTokenOffset(), length: 1, content: "" });
  } else {
    const previous = entries?.[index - 1];
    if (previous !== undefined) {
      scanner.setPosition(previous.offset + previous.length);
      scanner.scan();
      if (source[scanner.getTokenOffset()] === ",") {
        edits.push({
          offset: scanner.getTokenOffset(),
          length: 1,
          content: "",
        });
      }
    }
  }
  return applyEdits(source, edits);
}

export function reconcileGeneratedOverrides(
  source: string,
  owns: (entry: unknown) => boolean,
  desired: readonly Record<string, unknown>[],
  options: Parameters<typeof modify>[3],
): string {
  const overrides: unknown = (parse(source) as { overrides?: unknown })
    .overrides;
  const existing = Array.isArray(overrides) ? overrides : [];
  const remaining = [...desired];
  const edits = new Map<number, Record<string, unknown> | undefined>();
  for (const [index, entry] of existing.entries()) {
    if (!owns(entry)) continue;
    const previous = entry as Record<string, unknown>;
    const match = remaining.findIndex(
      (candidate) =>
        candidate.generated === previous.generated &&
        // Imported overrides follow the incoming Prettier order inside the
        // generated slots. Engine overrides keep their existing workspace slots.
        (candidate.generated !== "prettier-engine" ||
          (isDeepStrictEqual(candidate.files, previous.files) &&
            isDeepStrictEqual(candidate.excludeFiles, previous.excludeFiles))),
    );
    const replacement =
      match === -1 ? undefined : remaining.splice(match, 1)[0];
    if (!isDeepStrictEqual(previous, replacement))
      edits.set(index, replacement);
  }
  for (const [index, replacement] of [...edits].reverse()) {
    source =
      replacement === undefined
        ? removeGeneratedOverride(source, index)
        : applyEdits(
            source,
            modify(source, ["overrides", index], replacement, options),
          );
  }
  for (const entry of remaining) {
    source = applyEdits(
      source,
      modify(source, ["overrides", -1], entry, options),
    );
  }
  return source;
}
