import {
  CapturedDependencies,
  type DependencyCaptureContext,
} from "../../cache/captured-dependencies.js";
import { analysisKey, analysisStore } from "../analysis-reuse.js";
import { DEPENDENCY_LIMITS } from "../../cache/dependency-inputs.js";

const captures = Symbol("compiler dependency captures");
export const compilerPrograms = Symbol("snapshot compiler programs");

/** A reused program keeps this capture as its live host, including lazy reads.
 * Each new collection validates served dependency bytes against a fresh view.
 */
export function captureAnalysisDependencies(
  context: DependencyCaptureContext,
): CapturedDependencies {
  const store = analysisStore<CapturedDependencies>(captures);
  const key = analysisKey({
    repositoryRoot: context.repositoryRoot,
    snapshots: context.snapshots,
  });
  if (store === undefined || key === undefined)
    return new CapturedDependencies(context);
  const previous = store.get(key);
  const manifest = previous?.manifest();
  if (
    previous !== undefined &&
    manifest !== undefined &&
    previous.validate(manifest)
  )
    return previous;
  // Programs close over their capture. Drop those owners before replacing an
  // invalidated capture so stale dependency bytes are not retained indirectly.
  if (previous !== undefined) analysisStore(compilerPrograms)?.clear();
  const capture = new CapturedDependencies(context);
  store.set(
    key,
    capture,
    DEPENDENCY_LIMITS.bytes * 2 + DEPENDENCY_LIMITS.metadataBytes * 2,
  );
  return capture;
}
