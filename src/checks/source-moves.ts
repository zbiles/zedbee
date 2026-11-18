import { collectMetricEntitySpans } from "../attribution/entities.js";
import {
  buildSourceMoveMap,
  SOURCE_MOVE_LIMITS,
  type SourceMoveFile,
  type SourceMoveMap,
} from "../attribution/source-moves.js";
import { createFilePolicyResolver } from "../config/file-policy.js";
import { analysisKey, analysisStore } from "./analysis-reuse.js";
import type { CheckRunContext } from "./adapter.js";
import type { CheckId } from "../config/schema.js";
import {
  captureSnapshotRegistry,
  IGNORED_DIRECTORY_NAMES,
} from "../inspection/snapshot-registry.js";
import {
  ContainedFileSizeError,
  canonicalizeSnapshotRoot,
  readContainedFile,
} from "../inspection/read-json.js";

const syntaxMoves = Symbol("selected source syntax moves v1");
const matchedMoves = Symbol("policy-equivalent captured source moves v1");
const capturedMoves = Symbol("captured selected move sources v1");
type Sources = Readonly<Record<string, Omit<SourceMoveFile, "policyIdentity">>>;

/** No checkout reads or repository-wide inventory: only changed snapshot members. */
export async function sourceMoves(
  context: CheckRunContext,
  check: CheckId,
  options: { readonly crossFileOnly?: boolean } = {},
): Promise<SourceMoveMap> {
  context.signal.throwIfAborted();
  if (options.crossFileOnly === true) {
    // One ordinary source edit cannot supply a different file with a donor.
    // Skip optional capture before reading/parsing either side. Single-file
    // syntax-local diagnostic mapping is deferred to result attribution.
    let sourceChanges = 0;
    let renamedSource = false;
    for (const file of context.changeSet.files.values()) {
      if (
        !/\.(?:[cm]?[jt]sx?)$/iu.test(file.path) &&
        !/\.(?:[cm]?[jt]sx?)$/iu.test(file.previousPath ?? "")
      )
        continue;
      sourceChanges++;
      renamedSource ||= file.status === "renamed";
      if (renamedSource || sourceChanges > 1) break;
    }
    if (!renamedSource && sourceChanges < 2)
      return { pairs: [], ambiguous: [], unmatched: [], diagnostics: [] };
  }
  const key = analysisKey([
    context.snapshots.baselineDir,
    context.snapshots.targetDir,
    [...context.changeSet.files.values()],
  ]);
  const store =
    analysisStore<Promise<{ baseline: Sources; target: Sources }>>(
      capturedMoves,
    );
  let captured = key === undefined ? undefined : store?.get(key);
  if (captured === undefined) {
    captured = (async () => {
      let bytes = 0,
        entities = 0,
        fileCount = 0;
      const capture = async (side: "baseline" | "target"): Promise<Sources> => {
        const inspection =
          side === "baseline"
            ? context.baselineInspection
            : context.targetInspection;
        const membership = new Set(
          inspection.workspaces.flatMap((workspace) => workspace.sourceFiles),
        );
        const paths = [
          ...new Set(
            [...context.changeSet.files.values()].flatMap((file) =>
              side === "baseline"
                ? file.status === "added"
                  ? []
                  : [file.previousPath ?? file.path]
                : file.status === "deleted"
                  ? []
                  : [file.path],
            ),
          ),
        ].filter(
          (path) => membership.has(path) && /\.(?:[cm]?[jt]sx?)$/iu.test(path),
        );
        fileCount += paths.length;
        if (fileCount > SOURCE_MOVE_LIMITS.maxFiles)
          throw new RangeError("Move source budget");
        const root = await canonicalizeSnapshotRoot(
          side === "baseline"
            ? context.snapshots.baselineDir
            : context.snapshots.targetDir,
        );
        if (root !== inspection.snapshotRoot)
          throw new TypeError("Move capture inspection mismatch");
        const registry = await captureSnapshotRegistry(root, paths);
        const files: Record<
          string,
          Omit<SourceMoveFile, "policyIdentity">
        > = {};
        for (const path of paths.sort()) {
          context.signal.throwIfAborted();
          const entry = registry.resolve(path);
          if (entry === undefined)
            throw new TypeError("Move capture source unavailable");
          if (
            entry.kind !== "file" ||
            entry.targetKind !== "file" ||
            path
              .split("/")
              .some((part) =>
                new Set<string>(IGNORED_DIRECTORY_NAMES).has(part),
              ) ||
            entry.canonicalPath !== entry.absolutePath
          )
            continue;
          const source = await readContainedFile(registry, path, {
            maxBytes: Math.min(512 * 1024, SOURCE_MOVE_LIMITS.maxBytes - bytes),
          });
          bytes += Buffer.byteLength(source);
          const spans = collectMetricEntitySpans(source, path);
          entities += spans.length;
          if (entities > SOURCE_MOVE_LIMITS.maxEntities)
            throw new RangeError("Move entity budget");
          files[path] = { source, entities: spans };
        }
        return files;
      };
      return {
        baseline: await capture("baseline"),
        target: await capture("target"),
      };
    })();
    if (key !== undefined)
      store?.set(key, captured, SOURCE_MOVE_LIMITS.maxBytes * 6);
  }
  try {
    const sources = await captured;
    // Renames normally resolve baseline policy at the new path. Movement also
    // requires policy parity at the old path, before that rename projection.
    const baselinePolicy = createFilePolicyResolver(
      context.filePolicyConfig ?? context.config,
      { ...context.changeSet, files: new Map() },
    );
    const withPolicies = (side: "baseline" | "target") =>
      Object.fromEntries(
        Object.entries(sources[side]).map(([file, value]) => [
          file,
          {
            ...value,
            policyIdentity:
              analysisKey([
                context.policyForFile(check, file, side),
                side === "baseline"
                  ? baselinePolicy(check, file, side)
                  : context.policyForFile(check, file, side),
              ]) ?? `uncomparable:${side}:${file}`,
          },
        ]),
      );
    const baseline = withPolicies("baseline"),
      target = withPolicies("target");
    const mapStore = analysisStore<SourceMoveMap>(matchedMoves);
    const mapKey = analysisKey([
      key,
      Object.entries(baseline).map(([file, value]) => [
        file,
        value.policyIdentity,
      ]),
      Object.entries(target).map(([file, value]) => [
        file,
        value.policyIdentity,
      ]),
    ]);
    const retained = mapKey === undefined ? undefined : mapStore?.get(mapKey);
    if (retained !== undefined) return retained;
    // Syntax and occurrence accounting are independent of check policy. Build
    // their bounded index once and reuse it across both metrics and React.
    const syntaxStore = analysisStore<SourceMoveMap>(syntaxMoves);
    let syntax = key === undefined ? undefined : syntaxStore?.get(key);
    if (syntax === undefined) {
      const withoutPolicy = (side: "baseline" | "target") =>
        Object.fromEntries(
          Object.entries(sources[side]).map(([file, value]) => [
            file,
            { ...value, policyIdentity: "syntax" },
          ]),
        );
      syntax = buildSourceMoveMap({
        baseline: withoutPolicy("baseline"),
        target: withoutPolicy("target"),
        changes: context.changeSet.files,
        signal: context.signal,
      });
      if (key !== undefined)
        syntaxStore?.set(key, syntax, SOURCE_MOVE_LIMITS.maxBytes * 6);
    }
    const equivalent = (pair: SourceMoveMap["pairs"][number]) =>
      baseline[pair.baseline.entity.file]?.policyIdentity ===
      target[pair.target.entity.file]?.policyIdentity;
    const result: SourceMoveMap = {
      ...syntax,
      pairs: syntax.pairs.filter(equivalent),
      unmatched: [
        ...syntax.unmatched,
        ...syntax.pairs
          .filter((pair) => !equivalent(pair))
          .map((pair) => pair.target),
      ],
    };
    if (mapKey !== undefined)
      mapStore?.set(mapKey, result, SOURCE_MOVE_LIMITS.maxBytes * 6);
    return result;
  } catch (error) {
    context.signal.throwIfAborted();
    return {
      pairs: [],
      ambiguous: [],
      unmatched: [],
      diagnostics: [
        error instanceof RangeError || error instanceof ContainedFileSizeError
          ? "SOURCE_MOVE_BUDGET_EXCEEDED"
          : "SOURCE_MOVE_CAPTURE_UNAVAILABLE",
      ],
    };
  }
}

export function workspaceOwns(
  context: CheckRunContext,
  side: "baseline" | "target",
  file: string,
): boolean {
  const inspection =
    side === "baseline" ? context.baselineInspection : context.targetInspection;
  return (
    inspection.workspaces
      .find(
        (workspace) => workspace.relativeRoot === context.target.relativeRoot,
      )
      ?.sourceFiles.includes(file) ?? false
  );
}
