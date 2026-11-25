import { createHash } from "node:crypto";
import type { InspectionContext } from "../adapter.js";
import type { RepositoryInspection } from "../../inspection/types.js";
import {
  CapturedDependencies,
  type DependencyCaptureContext,
} from "../../cache/captured-dependencies.js";
import type { DependencyInputManifest } from "../../cache/dependency-inputs.js";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";
import { readContainedFile } from "../../inspection/read-json.js";
import { CheckIncompleteError } from "../incomplete-error.js";

export interface Witness {
  root: string;
  path: string;
  digest?: string;
  directory?: true;
  limit: number;
}
export interface ProofRecord {
  key: string;
  manifest: DependencyInputManifest;
  context: DependencyCaptureContext;
  witnesses: Witness[];
}
interface Owner {
  invalidated: boolean;
  records: Map<string, ProofRecord>;
  bytes: number;
  ids: WeakMap<object, number>;
  next: number;
}
const owners = new WeakMap<RepositoryInspection, Owner>();
// A proof may temporarily own a full dependency capture. Serialize acquisition
// and cap retained witness metadata separately, below the reuse owner's budget.
let activeProof = false;
const waiting: Array<() => void> = [];
export async function acquireCompilerProof<T>(
  signal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  await new Promise<void>((accept, reject) => {
    const start = () => {
      signal?.removeEventListener("abort", cancel);
      activeProof = true;
      accept();
    };
    const cancel = () => {
      const index = waiting.indexOf(start);
      if (index !== -1) waiting.splice(index, 1);
      reject(signal!.reason);
    };
    if (!activeProof) start();
    else {
      waiting.push(start);
      signal?.addEventListener("abort", cancel, { once: true });
    }
  });
  try {
    signal?.throwIfAborted();
    return await run();
  } finally {
    activeProof = false;
    waiting.shift()?.();
  }
}
export const proofDigest = (text: string) =>
  createHash("sha256").update(text).digest("hex");

export async function readProofInput(
  root: string,
  path: string,
  limit: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const registry = await captureSnapshotRegistry(root, [path]);
  if (registry.entries().some((e) => e.kind === "symlink"))
    throw Error("Unsupported proof input");
  const text = await readContainedFile(registry, path, { maxBytes: limit });
  signal?.throwIfAborted();
  return text;
}
export async function validCompilerProof(
  record: ProofRecord,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  if (!CapturedDependencies.validate(record.manifest, record.context))
    return false;
  for (const w of record.witnesses) {
    if (w.digest === undefined) {
      const registry = await captureSnapshotRegistry(w.root, [w.path]);
      signal?.throwIfAborted();
      if (registry.entries().some((e) => e.kind === "symlink")) return false;
      if (
        w.directory
          ? registry.resolve(w.path)?.targetKind !== "directory"
          : registry.resolve(w.path) !== undefined
      )
        return false;
    } else if (
      proofDigest(await readProofInput(w.root, w.path, w.limit, signal)) !==
      w.digest
    )
      return false;
  }
  signal?.throwIfAborted();
  return true;
}
/** Required after analyzer work, before allowing any result based on a skip. */
export async function validateCompilerScopeProofs(
  context: InspectionContext,
): Promise<void> {
  const signal = context.signal;
  const owner = owners.get(context.targetInspection);
  if (!owner) return;
  if (owner.invalidated)
    throw new CheckIncompleteError({
      code: "COMPARISON_INPUTS_CHANGED",
      message:
        "Inputs used to select compiler checks changed during this scan.",
      remediation:
        "Wait for dependency installation or file updates to finish, then rerun the scan.",
    });
  for (const record of owner.records.values()) {
    let verified = false;
    try {
      verified = await validCompilerProof(record, signal);
    } catch {
      signal?.throwIfAborted();
    }
    if (!verified)
      throw new CheckIncompleteError({
        code: "COMPARISON_INPUTS_CHANGED",
        message:
          "Inputs used to select compiler checks changed during this scan.",
        remediation:
          "Wait for dependency installation or file updates to finish, then rerun the scan.",
      });
  }
}
export function releaseCompilerScopeProofs(context: InspectionContext): void {
  owners.delete(context.targetInspection);
}
function identity(owner: Owner, value: object) {
  let id = owner.ids.get(value);
  if (id === undefined) {
    id = owner.next++;
    owner.ids.set(value, id);
  }
  return id;
}

export function compilerProofSlot(
  context: InspectionContext,
  workspaceRoot: string,
) {
  let owner = owners.get(context.targetInspection);
  if (owner === undefined) {
    owner = {
      records: new Map(),
      bytes: 0,
      ids: new WeakMap(),
      next: 0,
      invalidated: false,
    };
    owners.set(context.targetInspection, owner);
  }
  const key = JSON.stringify([
    identity(owner, context.baselineInspection),
    identity(owner, context.targetInspection),
    identity(owner, context.changeSet),
    workspaceRoot,
    context.repositoryRoot,
    context.mergeComparison
      ? "merge"
      : context.baseComparison
        ? "base"
        : "index",
  ]);
  const retained = owner;
  return {
    key,
    previous: retained.records.get(key),
    invalidate(previous: ProofRecord) {
      retained.invalidated = true;
      retained.records.delete(key);
      retained.bytes -= JSON.stringify(previous).length * 2;
    },
    retain(record: ProofRecord): boolean {
      const bytes = JSON.stringify(record).length * 2;
      if (
        retained.records.size >= 256 ||
        retained.bytes + bytes > 32 * 1024 * 1024
      )
        return false;
      retained.records.set(key, record);
      retained.bytes += bytes;
      return true;
    },
  };
}
