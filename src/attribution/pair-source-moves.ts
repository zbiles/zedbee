import { createHash } from "node:crypto";
import type { Observation, SourceLocation } from "../core/types.js";
import type { SourceMoveMap, SourceMovePair } from "./source-moves.js";

/** Canonical target fields must all move together for metric fingerprint lookup. */
export function pairSourceMoveMetrics(
  baseline: readonly Observation[],
  target: readonly Observation[],
  moves: SourceMoveMap,
): readonly Observation[] {
  const pairs = new Map(
    moves.pairs.map((pair) => [pair.baseline.entity.identity, pair]),
  );
  const targets = new Map(
    target
      .filter((observation) => observation.entity !== undefined)
      .map((observation) => [observation.identity, observation]),
  );
  return baseline.map((observation) => {
    const pair =
      observation.entity === undefined
        ? undefined
        : pairs.get(observation.identity);
    const next =
      pair === undefined ? undefined : targets.get(pair.target.entity.identity);
    return next === undefined
      ? observation
      : {
          ...observation,
          identity: next.identity,
          ...(next.entity === undefined ? {} : { entity: next.entity }),
          ...(next.location === undefined ? {} : { location: next.location }),
        };
  });
}
function offset(
  source: string,
  line: number | undefined,
  column: number | undefined,
): number | undefined {
  if (line === undefined || column === undefined) return undefined;
  let start = 0;
  for (let current = 1; current < line; current++) {
    start = source.indexOf("\n", start);
    if (start < 0) return undefined;
    start++;
  }
  return start + column - 1;
}
function position(source: string, value: number) {
  let line = 1;
  let lineStart = 0;
  for (
    let index = source.indexOf("\n");
    index !== -1 && index < value;
    index = source.indexOf("\n", index + 1)
  ) {
    line += 1;
    lineStart = index + 1;
  }
  return { line, column: value - lineStart + 1 };
}
function mappedLocation(
  location: SourceLocation,
  pair: SourceMovePair,
  before: string,
  after: string,
): SourceLocation | undefined {
  const start = offset(before, location.startLine, location.startColumn);
  const end = offset(
    before,
    location.endLine ?? location.startLine,
    location.endColumn ?? location.startColumn,
  );
  if (start === undefined || end === undefined) return undefined;
  const map = (value: number, ending: boolean) => {
    const index = pair.baseline.tokens.findIndex(
      (token) =>
        token.start <= value &&
        (ending ? value <= token.end : value < token.end),
    );
    const old = pair.baseline.tokens[index],
      next = pair.target.tokens[index];
    return old === undefined || next === undefined
      ? undefined
      : next.start + value - old.start;
  };
  const nextStart = map(start, false),
    nextEnd = map(end, true);
  if (nextStart === undefined || nextEnd === undefined) return undefined;
  const a = position(after, nextStart),
    b = position(after, nextEnd);
  return {
    file: pair.target.entity.file,
    startLine: a.line,
    startColumn: a.column,
    ...(location.endLine === undefined ? {} : { endLine: b.line }),
    ...(location.endColumn === undefined ? {} : { endColumn: b.column }),
  };
}
export function pairSourceMoveLocations(
  baseline: readonly Observation[],
  target: readonly Observation[],
  moves: SourceMoveMap,
  files: {
    baseline: Readonly<Record<string, string>>;
    target: Readonly<Record<string, string>>;
  },
): {
  baselineObservations: readonly Observation[];
  targetObservations: readonly Observation[];
} {
  const eligible = (observation: Observation) =>
    observation.check === "reactCorrectness" &&
    observation.rule === "react/no-unescaped-entities";
  const identity = (
    observation: Observation,
    location = observation.location,
  ) =>
    createHash("sha256")
      .update(
        JSON.stringify([
          observation.rule,
          observation.severity,
          location,
          observation.comparisonIdentity ?? observation.message,
        ]),
      )
      .digest("hex");
  return {
    baselineObservations: baseline.map((observation) => {
      if (!eligible(observation) || observation.location === undefined)
        return observation;
      const pairs = moves.pairs
        .filter(
          (pair) =>
            pair.syntaxEqual &&
            pair.baseline.entity.file === observation.location!.file &&
            pair.baseline.entity.startLine <=
              observation.location!.startLine! &&
            pair.baseline.entity.endLine >=
              (observation.location!.endLine ??
                observation.location!.startLine!),
        )
        .sort(
          (a, b) =>
            a.baseline.endOffset -
            a.baseline.startOffset -
            (b.baseline.endOffset - b.baseline.startOffset),
        );
      const pair = pairs[0];
      const before = files.baseline[observation.location.file],
        after =
          pair === undefined
            ? undefined
            : files.target[pair.target.entity.file];
      const mapped =
        pair === undefined || before === undefined || after === undefined
          ? undefined
          : mappedLocation(observation.location, pair, before, after);
      return {
        ...observation,
        comparisonIdentity: identity(
          observation,
          mapped ?? observation.location,
        ),
      };
    }),
    targetObservations: target.map((observation) =>
      eligible(observation)
        ? { ...observation, comparisonIdentity: identity(observation) }
        : observation,
    ),
  };
}
