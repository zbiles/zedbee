import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readlink, realpath } from "node:fs/promises";
import { isAbsolute, posix, relative, sep } from "node:path";
import {
  dependencyPathParts,
  isInstalledDependencyPath,
  type DependencyInputManifest,
} from "./dependency-inputs.js";
import pLimit from "p-limit";
import type { CheckTarget } from "../checks/adapter.js";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import { createFilePolicyResolver } from "../config/file-policy.js";
import type {
  CheckId,
  ResolvedCheckPolicy,
  ResolvedConfig,
} from "../config/schema.js";
import {
  immutableConfigurationSnapshot,
  snapshotManagedPolicy,
} from "../config/settings-registry.js";
import { compareCodeUnits } from "../core/compare.js";
import { ZEDBEE_VERSION } from "../core/package-version.js";
import type { ChangeSet } from "../git/change-set.js";
import { isGitObjectId } from "../git/base-ref.js";
import { captureSnapshotRegistry } from "../inspection/snapshot-registry.js";
import type { ScanMode } from "../scan/source-mode.js";
export { observationCacheEngineIdentity } from "../checks/engine-identity.js";
export {
  isCacheableObservationCheck,
  type CacheableObservationCheckId,
} from "../checks/metadata.js";

export interface ObservationCacheKeyInput {
  readonly checkId: string;
  readonly engineIdentity: string;
  readonly policy: Readonly<ResolvedCheckPolicy>;
  readonly checkTarget: CheckTarget;
  readonly baselineRoot: string;
  readonly targetRoot: string;
  readonly mode: ScanMode;
  readonly baseline: "HEAD" | string | null;
  readonly target: "index" | string;
  readonly relevantConfig?: unknown;
  readonly nodeVersion?: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly zedbeeVersion?: string;
}

interface CacheSourceIdentity {
  readonly mode: ScanMode;
  readonly baseline: "HEAD" | string | null;
  readonly target: "index" | string;
}

function validatedCacheSource(
  source: CacheSourceIdentity,
): CacheSourceIdentity {
  if (source.mode === "index") {
    if (
      source.target !== "index" ||
      (source.baseline !== null &&
        source.baseline !== "HEAD" &&
        !isGitObjectId(source.baseline))
    ) {
      throw new TypeError("Expected a valid index cache source identity");
    }
    return Object.freeze({ ...source });
  }
  if (!isGitObjectId(source.baseline) || !isGitObjectId(source.target)) {
    throw new TypeError("Expected a valid committed cache source identity");
  }
  return Object.freeze({ ...source });
}

function targetPolicyRenames(
  changeSet: ChangeSet,
): ReadonlyMap<string, string> {
  const renames = new Map<string, string>();
  for (const file of changeSet.files.values()) {
    if (file.status !== "renamed") continue;
    if (file.previousPath === undefined) {
      throw new TypeError("Expected a renamed file to have a baseline path");
    }
    const baselinePath = normalizeRepositoryRelativePath(file.previousPath);
    const targetPath = normalizeRepositoryRelativePath(file.path);
    const existing = renames.get(baselinePath);
    if (existing !== undefined && existing !== targetPath) {
      throw new TypeError(
        "Expected each baseline path to have one target path",
      );
    }
    renames.set(baselinePath, targetPath);
  }
  return renames;
}

function targetPolicyPaths(
  paths: readonly string[],
  renames: ReadonlyMap<string, string>,
): readonly string[] {
  return Object.freeze(
    [
      ...new Set(
        paths.map((path) => {
          const normalized = normalizeRepositoryRelativePath(path);
          return renames.get(normalized) ?? normalized;
        }),
      ),
    ].sort(compareCodeUnits),
  );
}

type EffectiveBehaviorFingerprint = Readonly<{
  repository: unknown;
  files: readonly Readonly<{ path: string; policy: unknown }>[];
}>;

/** Build once for an immutable dispatch, and only when a cache key is needed. */
export function createEffectiveBehaviorFingerprint(
  config: ResolvedConfig,
  changeSet: ChangeSet,
): (
  checkId: CheckId,
  paths: readonly string[],
) => EffectiveBehaviorFingerprint {
  const policyForFile = createFilePolicyResolver(config, changeSet);
  const renames = targetPolicyRenames(changeSet);
  return (checkId, paths) => {
    const files = Object.freeze(
      targetPolicyPaths(paths, renames).map((path) =>
        Object.freeze({
          path,
          policy: snapshotManagedPolicy(
            checkId,
            policyForFile(checkId, path, "target"),
          ),
        }),
      ),
    );
    return immutableConfigurationSnapshot({
      repository: {
        profile: config.profile,
        policy: snapshotManagedPolicy(checkId, config.checks[checkId]),
      },
      files,
    });
  };
}

export function effectiveBehaviorFingerprint(
  config: ResolvedConfig,
  checkId: CheckId,
  paths: readonly string[],
  changeSet: ChangeSet,
): EffectiveBehaviorFingerprint {
  return createEffectiveBehaviorFingerprint(config, changeSet)(checkId, paths);
}

/** Collection attribution depends on metadata even when snapshot bytes match. */
export function changeSetCacheDigest(changeSet: ChangeSet): string {
  const files = [...changeSet.files.values()]
    .sort((left, right) => compareCodeUnits(left.path, right.path))
    .map((file) => ({
      path: file.path,
      previousPath: file.previousPath,
      status: file.status,
      addedRanges: [...file.addedRanges]
        .sort((left, right) => left.start - right.start || left.end - right.end)
        .map(({ start, end }) => ({ start, end })),
    }));
  return createHash("sha256")
    .update(
      JSON.stringify(stable({ isEmpty: changeSet.isEmpty, files })),
      "utf8",
    )
    .digest("hex");
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => compareCodeUnits(left, right))
      .map(([key, nested]) => [key, stable(nested)]),
  );
}

type SnapshotInputIdentity =
  | { readonly path: string; readonly kind: "directory" }
  | { readonly path: string; readonly kind: "symlink"; readonly target: string }
  | { readonly path: string; readonly kind: "file"; readonly digest: string };
interface SnapshotCacheIdentity {
  readonly root: string;
  readonly digest: string;
  readonly entriesByPath: ReadonlyMap<string, SnapshotInputIdentity>;
}

async function snapshotIdentity(root: string): Promise<SnapshotCacheIdentity> {
  const canonicalRoot = await realpath(root);
  const registry = await captureSnapshotRegistry(canonicalRoot);
  // An incomplete inventory cannot establish the existing full-snapshot key.
  for (const failure of registry.unavailableSymlinks?.values() ?? [])
    throw failure;
  const entries = [...registry.entries()].sort((left, right) =>
    compareCodeUnits(left.repositoryPath, right.repositoryPath),
  );
  const limit = pLimit(8);
  const identities = await Promise.all(
    entries.map((entry) =>
      limit(async () => {
        if (entry.kind === "directory") {
          return { path: entry.repositoryPath, kind: "directory" } as const;
        }
        if (entry.kind === "symlink") {
          return {
            path: entry.repositoryPath,
            kind: "symlink",
            target: await readlink(entry.absolutePath),
          } as const;
        }
        const hash = createHash("sha256");
        for await (const chunk of createReadStream(entry.canonicalPath, {
          highWaterMark: 64 * 1024,
        })) {
          hash.update(chunk as Buffer);
        }
        const digest = hash.digest("hex");
        return { path: entry.repositoryPath, kind: "file", digest } as const;
      }),
    ),
  );
  // Canonicalize the full inventory once per snapshot, shared by every target.
  const digest = createHash("sha256")
    .update(JSON.stringify(stable(identities)), "utf8")
    .digest("hex");
  return {
    root: canonicalRoot,
    digest,
    entriesByPath: new Map(identities.map((entry) => [entry.path, entry])),
  };
}

export async function createObservationCacheKey(
  input: ObservationCacheKeyInput,
): Promise<string> {
  return createObservationCacheKeyBuilder(
    input.baselineRoot,
    input.targetRoot,
    validatedCacheSource(input),
  )(input);
}

type SnapshotBoundKeyInput = Omit<
  ObservationCacheKeyInput,
  "baselineRoot" | "targetRoot" | "mode" | "baseline" | "target"
>;

/** Internal to one dispatch over immutable snapshots; never attach to adapters. */
export function createObservationCacheKeyBuilder(
  baselineRoot: string,
  targetRoot: string,
  source: CacheSourceIdentity,
): ((input: SnapshotBoundKeyInput) => Promise<string>) & {
  matchesSnapshotFiles(
    manifest: DependencyInputManifest | undefined,
  ): Promise<boolean>;
} {
  const validatedSource = validatedCacheSource(source);
  let identities:
    | Promise<readonly [SnapshotCacheIdentity, SnapshotCacheIdentity]>
    | undefined;
  const keyFor = async (input: SnapshotBoundKeyInput) => {
    // Share in-flight work as well as results. A rejected inventory disables
    // caching for this dispatch; a new dispatch will capture fresh identities.
    const [baseline, target] = await (identities ??= Promise.all([
      snapshotIdentity(baselineRoot),
      snapshotIdentity(targetRoot),
    ]));
    return observationCacheKey(
      input,
      validatedSource,
      baseline.digest,
      target.digest,
    );
  };
  return Object.assign(keyFor, {
    async matchesSnapshotFiles(
      manifest: DependencyInputManifest | undefined,
    ): Promise<boolean> {
      if (manifest === undefined || identities === undefined) return false;
      try {
        const snapshots = await identities;
        const roots = snapshots.map((snapshot) => snapshot.root);
        const maps = snapshots.map((snapshot) => snapshot.entriesByPath);
        const canonical = (path: string, index: number): string | undefined => {
          for (let depth = 0; depth < 32; depth++) {
            const parts = path.split("/");
            let changed = false;
            for (let length = parts.length; length > 0; length--) {
              const prefix = parts.slice(0, length).join("/");
              const entry = maps[index]!.get(prefix);
              if (entry?.kind !== "symlink") continue;
              const target = isAbsolute(entry.target)
                ? relative(roots[index]!, entry.target).split(sep).join("/")
                : posix.join(posix.dirname(prefix), entry.target);
              path = posix.join(target, ...parts.slice(length));
              if (path === ".." || path.startsWith("../")) return undefined;
              changed = true;
              break;
            }
            if (!changed) return path;
          }
          return undefined;
        };
        for (const probe of manifest.probes) {
          if (probe.kind !== "file") continue;
          const [scope, path] = dependencyPathParts(probe.path);
          const [realScope, realPath] = dependencyPathParts(probe.realPath);
          // Installed manifest reads are checked afresh by validateDependencyInputs;
          // they are deliberately not part of the source snapshot inventory.
          if (
            (scope === "packages" ||
              (scope === "repository" && isInstalledDependencyPath(path))) &&
            path.endsWith("/package.json") &&
            realScope === "repository" &&
            isInstalledDependencyPath(realPath) &&
            realPath.endsWith("/package.json")
          )
            continue;
          const index = scope === "baseline" ? 0 : scope === "target" ? 1 : -1;
          if (
            index < 0 ||
            scope !== realScope ||
            canonical(path, index) !== realPath
          )
            return false;
          const entry = maps[index]!.get(realPath);
          if (entry?.kind !== "file" || entry.digest !== probe.digest)
            return false;
        }
        return true;
      } catch {
        return false;
      }
    },
  });
}

function observationCacheKey(
  input: SnapshotBoundKeyInput,
  source: CacheSourceIdentity,
  baselineSnapshot: string,
  target: string,
): string {
  const payload = stable({
    // v4 also binds dispatch keys to a shared canonical changeset digest.
    schema: "zedbee-observation-cache-key-v4",
    mode: source.mode,
    baseline: source.baseline,
    target: source.target,
    checkId: input.checkId,
    engineIdentity: input.engineIdentity,
    policy: input.policy,
    checkTarget: input.checkTarget,
    baselineSnapshot,
    targetSnapshot: target,
    relevantConfig: input.relevantConfig,
    nodeVersion: input.nodeVersion ?? process.versions.node,
    platform: input.platform ?? process.platform,
    arch: input.arch ?? process.arch,
    zedbeeVersion: input.zedbeeVersion ?? ZEDBEE_VERSION,
  });
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}
