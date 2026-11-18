import { createHash } from "node:crypto";
import * as ts from "typescript";
import type { MetricEntitySpan } from "./entities.js";
import type { ChangeSet } from "../git/change-set.js";

export interface SourceMoveFile {
  readonly source: string;
  readonly entities: readonly MetricEntitySpan[];
  readonly policyIdentity: string;
}
interface Token {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
export interface SourceMoveEntity extends MetricEntitySpan {
  readonly tokens: readonly Token[];
}
export interface SourceMovePair {
  readonly baseline: SourceMoveEntity;
  readonly target: SourceMoveEntity;
  /** Modified same-location/rename continuations are suitable only for metric deltas. */
  readonly syntaxEqual: boolean;
}
export interface SourceMoveMap {
  readonly pairs: readonly SourceMovePair[];
  readonly unmatched: readonly SourceMoveEntity[];
  readonly ambiguous: readonly {
    baseline: readonly SourceMoveEntity[];
    target: readonly SourceMoveEntity[];
  }[];
  readonly diagnostics: readonly string[];
}
export const SOURCE_MOVE_LIMITS = Object.freeze({
  maxFiles: 128,
  maxBytes: 4 * 1024 * 1024,
  maxEntities: 10_000,
  maxTokens: 250_000,
  maxMilliseconds: 2_000,
});

/** Pure, bounded matching over selected, immutable captured sources only. */
export function buildSourceMoveMap(input: {
  readonly baseline: Readonly<Record<string, SourceMoveFile>>;
  readonly target: Readonly<Record<string, SourceMoveFile>>;
  readonly changes: ChangeSet["files"];
  readonly limits?: Partial<Record<keyof typeof SOURCE_MOVE_LIMITS, number>>;
  readonly signal?: AbortSignal;
}): SourceMoveMap {
  input.signal?.throwIfAborted();
  const limits = { ...SOURCE_MOVE_LIMITS, ...input.limits };
  const started = performance.now();
  const empty = (reason: string): SourceMoveMap => ({
    pairs: [],
    unmatched: [],
    ambiguous: [],
    diagnostics: [reason],
  });
  const beforePaths = new Set<string>();
  const afterPaths = new Set<string>();
  const renames = new Map<string, string>();
  for (const file of input.changes.values()) {
    if (file.status !== "added")
      beforePaths.add(file.previousPath ?? file.path);
    if (file.status !== "deleted") afterPaths.add(file.path);
    if (file.status === "renamed" && file.previousPath !== undefined)
      renames.set(file.previousPath, file.path);
  }
  const selected = (
    files: Readonly<Record<string, SourceMoveFile>>,
    paths: ReadonlySet<string>,
  ) =>
    Object.entries(files)
      .filter(([file]) => paths.has(file))
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const before = selected(input.baseline, beforePaths);
  const after = selected(input.target, afterPaths);
  const all = [...before, ...after];
  if (
    all.length > limits.maxFiles ||
    all.reduce((sum, [, file]) => sum + Buffer.byteLength(file.source), 0) >
      limits.maxBytes ||
    all.reduce((sum, [, file]) => sum + file.entities.length, 0) >
      limits.maxEntities
  )
    return empty("SOURCE_MOVE_BUDGET_EXCEEDED");
  let tokenCount = 0;
  let entityTokenCount = 0;
  const keys = new Map<SourceMoveEntity, string>();
  const policies = new Map<SourceMoveEntity, string>();
  const payload = (entity: MetricEntitySpan["entity"]) =>
    entity.identity.slice(`${entity.kind}:${entity.file}:`.length);
  const collect = (files: typeof before): SourceMoveEntity[] =>
    files.flatMap(([file, value]) => {
      input.signal?.throwIfAborted();
      if (performance.now() - started > limits.maxMilliseconds)
        throw new RangeError("budget");
      // Directive comments can alter analysis; arbitrary comments cannot establish equivalence.
      if (/\b(?:eslint|@ts-|@jsx|istanbul|c8\s+ignore)/u.test(value.source))
        // Dropping a file would also erase retained occurrences, allowing a copy
        // to consume their baseline. Decline the whole optional match instead.
        throw new SyntaxError("unsupported directive context");
      const parsed = ts.createSourceFile(
        file,
        value.source,
        ts.ScriptTarget.Latest,
        true,
      );
      if (
        (parsed as ts.SourceFile & { parseDiagnostics: readonly unknown[] })
          .parseDiagnostics.length > 0
      )
        throw new SyntaxError("parse");
      const directives: string[] = [];
      for (const statement of parsed.statements) {
        if (
          !ts.isExpressionStatement(statement) ||
          !ts.isStringLiteral(statement.expression)
        )
          break;
        directives.push(statement.expression.getText(parsed));
      }
      const tokens: Token[] = [];
      const visit = (node: ts.Node): void => {
        if (performance.now() - started > limits.maxMilliseconds)
          throw new RangeError("budget");
        const children = node.getChildren(parsed);
        if (children.length > 0) {
          for (const child of children) visit(child);
          return;
        }
        if (
          node.kind === ts.SyntaxKind.EndOfFileToken ||
          node.kind === ts.SyntaxKind.SyntaxList
        )
          return;
        tokens.push({
          start: node.getStart(parsed),
          end: node.getEnd(),
          text: `${node.kind}:${node.getText(parsed)}`,
        });
        if (++tokenCount > limits.maxTokens) throw new RangeError("budget");
      };
      visit(parsed);
      return value.entities.map((span) => {
        input.signal?.throwIfAborted();
        if (performance.now() - started > limits.maxMilliseconds)
          throw new RangeError("budget");
        let low = 0,
          high = tokens.length;
        while (low < high) {
          const middle = (low + high) >>> 1;
          if (tokens[middle]!.start < span.startOffset) low = middle + 1;
          else high = middle;
        }
        const selected: Token[] = [];
        for (
          let index = low;
          index < tokens.length && tokens[index]!.end <= span.endOffset;
          index++
        ) {
          if (++entityTokenCount > limits.maxTokens)
            throw new RangeError("budget");
          selected.push(tokens[index]!);
        }
        const entity = { ...span, tokens: selected };
        const key = createHash("sha256")
          .update(
            JSON.stringify([
              span.entity.kind,
              payload(span.entity),
              directives,
              entity.tokens.map((token) => token.text),
            ]),
          )
          .digest("hex");
        keys.set(entity, key);
        policies.set(entity, value.policyIdentity);
        return entity;
      });
    });
  let baseline: SourceMoveEntity[], target: SourceMoveEntity[];
  try {
    baseline = collect(before);
    target = collect(after);
  } catch (error) {
    input.signal?.throwIfAborted();
    return empty(
      error instanceof RangeError
        ? "SOURCE_MOVE_BUDGET_EXCEEDED"
        : "SOURCE_MOVE_PARSE_UNSUPPORTED",
    );
  }
  const pairs: SourceMovePair[] = [];
  const usedBefore = new Set<SourceMoveEntity>(),
    usedAfter = new Set<SourceMoveEntity>();
  const add = (old: SourceMoveEntity, next: SourceMoveEntity) => {
    usedBefore.add(old);
    usedAfter.add(next);
    if (policies.get(old) === policies.get(next))
      pairs.push({
        baseline: old,
        target: next,
        syntaxEqual: keys.get(old) === keys.get(next),
      });
  };
  const continuations = new Map<string, SourceMoveEntity[]>();
  for (const entity of target) {
    const key = `${entity.entity.file}\0${payload(entity.entity)}`;
    const group = continuations.get(key) ?? [];
    group.push(entity);
    continuations.set(key, group);
  }
  const oldCounts = new Map<string, number>();
  for (const entity of baseline) {
    const key = `${renames.get(entity.entity.file) ?? entity.entity.file}\0${payload(entity.entity)}`;
    oldCounts.set(key, (oldCounts.get(key) ?? 0) + 1);
  }
  // Reserve retained entities, even when modified or policy-incompatible: they cannot donate copies.
  for (const entity of baseline) {
    const key = `${renames.get(entity.entity.file) ?? entity.entity.file}\0${payload(entity.entity)}`;
    const candidates = continuations.get(key);
    if (oldCounts.get(key) === 1 && candidates?.length === 1)
      add(entity, candidates[0]!);
    else if (candidates !== undefined) {
      usedBefore.add(entity);
      for (const candidate of candidates) usedAfter.add(candidate);
    }
  }
  const groups = new Map<
    string,
    { baseline: SourceMoveEntity[]; target: SourceMoveEntity[] }
  >();
  for (const [side, entities, used] of [
    ["baseline", baseline, usedBefore],
    ["target", target, usedAfter],
  ] as const) {
    for (const entity of entities) {
      if (used.has(entity)) continue;
      const key = keys.get(entity)!;
      const group = groups.get(key) ?? { baseline: [], target: [] };
      group[side].push(entity);
      groups.set(key, group);
    }
  }
  const ambiguous: SourceMoveMap["ambiguous"][number][] = [];
  for (const group of groups.values()) {
    if (group.baseline.length === 1 && group.target.length === 1)
      add(group.baseline[0]!, group.target[0]!);
    else if (group.baseline.length > 0 && group.target.length > 0)
      ambiguous.push(group);
  }
  const matchedTargets = new Set(pairs.map((pair) => pair.target));
  return {
    pairs,
    unmatched: target.filter((entity) => !matchedTargets.has(entity)),
    ambiguous,
    diagnostics: [],
  };
}
