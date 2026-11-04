import { diffLines } from "diff";
import {
  collectMetricEntitySpans,
  type MetricEntitySpan,
} from "../../attribution/entities.js";
import type { Observation } from "../../core/types.js";
import type { ChangeSet } from "../../git/change-set.js";

export interface ComplexitySnapshot {
  readonly observations: readonly Observation[];
  readonly files: Readonly<Record<string, string>>;
}

interface ClassMember {
  readonly span: MetricEntitySpan;
  readonly payload: string;
  readonly scopes: readonly string[];
  readonly sourceKey: string;
}

function members(source: string, file: string): readonly ClassMember[] {
  return collectMetricEntitySpans(source, file).flatMap((span) => {
    const payload = span.entity.identity.slice(
      `${span.entity.kind}:${file}:`.length,
    );
    const segments = payload.split("/");
    const scopes = segments.flatMap((segment, index) =>
      segment.startsWith("class-scope=")
        ? [segments.slice(0, index + 1).join("/")]
        : [],
    );
    if (scopes.length === 0) return [];
    return [
      {
        span,
        payload,
        scopes,
        sourceKey: JSON.stringify([
          span.entity.kind,
          span.entity.name,
          payload
            .replace(/class-scope=[^/]+/gu, "class-scope=*")
            .replace(/field-scope=[^/]+/gu, "field-scope=*"),
          source.slice(span.startOffset, span.endOffset),
        ]),
      },
    ];
  });
}

function scopeOwner(scope: string): string {
  const segments = scope.split("/");
  return segments.slice(0, -1).join("/");
}

function groupedScopes(
  input: readonly ClassMember[],
): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const member of input) {
    for (const scope of member.scopes) {
      const owner = scopeOwner(scope);
      const group = result.get(owner) ?? new Set<string>();
      group.add(scope);
      result.set(owner, group);
    }
  }
  return result;
}

function remapScope(owner: string, pairs: ReadonlyMap<string, string>): string {
  for (let end = owner.length; end > 0; end = owner.lastIndexOf("/", end - 1)) {
    const prefix = owner.slice(0, end);
    const matched = pairs.get(prefix);
    if (matched !== undefined) return matched + owner.slice(end);
  }
  return owner;
}

function pairFileMembers(
  file: string,
  before: string,
  after: string,
  changeSet: ChangeSet,
): ReadonlyMap<string, string> {
  const baseline = members(before, file);
  const target = members(after, file);
  if (baseline.length === 0 || target.length === 0) return new Map();
  const components = diffLines(before, after, { timeout: 2_000 });
  if (components === undefined)
    throw new Error("Complexity comparison timed out.");
  const unchanged: { before: number; after: number; count: number }[] = [];
  let baselineLine = 1;
  let targetLine = 1;
  for (const component of components) {
    const count = component.count ?? 0;
    if (!component.added && !component.removed)
      unchanged.push({ before: baselineLine, after: targetLine, count });
    if (!component.added) baselineLine += count;
    if (!component.removed) targetLine += count;
  }
  const ranges = changeSet.files.get(file)?.addedRanges ?? [];
  const edited = (member: ClassMember) =>
    ranges.some(
      ({ start, end }) =>
        member.span.entity.startLine <= end &&
        member.span.entity.endLine >= start,
    );
  const baselineCounts = new Map<string, number>();
  for (const member of baseline)
    baselineCounts.set(
      member.sourceKey,
      (baselineCounts.get(member.sourceKey) ?? 0) + 1,
    );
  const targetGroups = new Map<
    string,
    {
      members: ClassMember[];
      unedited: ClassMember[];
      uneditedByLines: Map<string, ClassMember[]>;
    }
  >();
  for (const member of target) {
    const group: NonNullable<ReturnType<typeof targetGroups.get>> =
      targetGroups.get(member.sourceKey) ?? {
        members: [],
        unedited: [],
        uneditedByLines: new Map(),
      };
    group.members.push(member);
    if (!edited(member)) {
      group.unedited.push(member);
      const lines = `${member.span.entity.startLine}:${member.span.entity.endLine}`;
      const atLines = group.uneditedByLines.get(lines) ?? [];
      atLines.push(member);
      group.uneditedByLines.set(lines, atLines);
    }
    targetGroups.set(member.sourceKey, group);
  }
  const anchors = new Map<ClassMember, ClassMember>();
  for (const member of baseline) {
    const group = targetGroups.get(member.sourceKey);
    if (group === undefined) continue;
    const candidates = group.members;
    let start = 0;
    let end = unchanged.length;
    while (start < end) {
      const middle = (start + end) >>> 1;
      if (unchanged[middle]!.before <= member.span.entity.startLine)
        start = middle + 1;
      else end = middle;
    }
    const range = unchanged[start - 1];
    const span =
      range !== undefined &&
      member.span.entity.endLine < range.before + range.count
        ? range
        : undefined;
    const delta = span === undefined ? undefined : span.after - span.before;
    const mapped =
      delta === undefined
        ? []
        : (group.uneditedByLines.get(
            `${member.span.entity.startLine + delta}:${member.span.entity.endLine + delta}`,
          ) ?? []);
    const unedited = group.unedited;
    const uniqueBefore = baselineCounts.get(member.sourceKey) === 1;
    const candidate =
      mapped.length === 1
        ? mapped[0]
        : uniqueBefore && unedited.length === 1
          ? unedited[0]
          : uniqueBefore && candidates.length === 1
            ? candidates[0]
            : undefined;
    if (candidate !== undefined) anchors.set(member, candidate);
  }
  // Source anchors must be one-to-one before they can establish class ownership.
  const anchorCounts = new Map<ClassMember, number>();
  for (const candidate of anchors.values())
    anchorCounts.set(candidate, (anchorCounts.get(candidate) ?? 0) + 1);
  for (const [member, candidate] of anchors) {
    if (anchorCounts.get(candidate)! > 1) anchors.delete(member);
  }
  const forward = new Map<string, Set<string>>();
  const backward = new Map<string, Set<string>>();
  for (const [member, candidate] of anchors) {
    for (const [index, scope] of member.scopes.entries()) {
      const matched = candidate.scopes[index]!;
      const choices = forward.get(scope) ?? new Set<string>();
      choices.add(matched);
      forward.set(scope, choices);
      const origins = backward.get(matched) ?? new Set<string>();
      origins.add(scope);
      backward.set(matched, origins);
    }
  }
  const scopePairs = new Map<string, string>();
  for (const [scope, choices] of forward) {
    const [candidate] = choices;
    if (choices.size === 1 && backward.get(candidate!)?.size === 1)
      scopePairs.set(scope, candidate!);
  }
  const pairedTargets = new Set(scopePairs.values());
  const oldScopes = groupedScopes(baseline);
  const newScopes = groupedScopes(target);
  // After source anchors, only a single remaining old/new class can be paired
  // without guessing among rewritten siblings. Equal counts do not prove order.
  for (const [owner, siblings] of [...oldScopes].sort(
    ([left], [right]) => left.length - right.length,
  )) {
    const newOwner = remapScope(owner, scopePairs);
    const candidates = newScopes.get(newOwner);
    if (candidates?.size !== siblings.size) continue;
    if (
      [...siblings].some(
        (scope) =>
          (forward.has(scope) && !scopePairs.has(scope)) ||
          (scopePairs.has(scope) && !candidates.has(scopePairs.get(scope)!)),
      )
    )
      continue;
    const unmatchedOld = [...siblings].filter(
      (scope) => !scopePairs.has(scope),
    );
    const unmatchedNew = [...candidates].filter(
      (scope) => !pairedTargets.has(scope),
    );
    if (unmatchedOld.length === 1 && unmatchedNew.length === 1) {
      scopePairs.set(unmatchedOld[0]!, unmatchedNew[0]!);
      pairedTargets.add(unmatchedNew[0]!);
    }
  }
  const identities = new Map<string, string>();
  const targetByPayload = new Map(
    target.map((member) => [member.payload, member]),
  );
  for (const member of baseline) {
    const anchor = anchors.get(member);
    const candidate =
      anchor ?? targetByPayload.get(remapScope(member.payload, scopePairs));
    const hasPairedScope = member.scopes.every((scope) =>
      scopePairs.has(scope),
    );
    if (
      candidate !== undefined &&
      (anchor !== undefined || hasPairedScope) &&
      member.span.entity.kind === candidate.span.entity.kind &&
      member.span.entity.name === candidate.span.entity.name
    )
      identities.set(
        member.span.entity.identity,
        candidate.span.entity.identity,
      );
  }
  return identities;
}

/** Pair class-scoped baseline metrics to canonical target entities before delta attribution. */
export function pairClassMetricObservations(
  baseline: ComplexitySnapshot,
  target: ComplexitySnapshot,
  changeSet: ChangeSet,
): {
  readonly baselineObservations: readonly Observation[];
  readonly targetObservations: readonly Observation[];
} {
  const mappings = new Map<string, ReadonlyMap<string, string>>();
  return {
    baselineObservations: baseline.observations.flatMap((observation) => {
      if (!observation.identity.includes("class-scope=")) return [observation];
      const file = observation.entity?.file;
      if (file === undefined) return [];
      let identities = mappings.get(file);
      if (identities === undefined) {
        const before = baseline.files[file];
        const after = target.files[file];
        identities =
          before === undefined || after === undefined
            ? new Map()
            : pairFileMembers(file, before, after, changeSet);
        mappings.set(file, identities);
      }
      const identity = identities.get(observation.identity);
      return identity === undefined ? [] : [{ ...observation, identity }];
    }),
    targetObservations: target.observations,
  };
}
