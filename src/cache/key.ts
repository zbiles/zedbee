import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readlink, realpath } from "node:fs/promises";
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
import { captureSnapshotRegistry } from "../inspection/snapshot-registry.js";

const ENGINE_IDENTITIES = Object.freeze({
  lint: "eslint@9.39.5+typescript-eslint@8.67.0+zedbee-rules-v2+zedbee-multi-project-v1",
  types: "typescript@6.0.3+zedbee-program-v1",
  cyclomaticComplexity: "eslint@9.39.5+complexity-v1",
  readabilityComplexity: "eslint@9.39.5+zedbee-readability-v1",
  structuralSecurity: "ast-grep@0.45.1+zedbee-structural-rules-v1",
  duplication: "jscpd@5.0.15+zedbee-clone-normalization-v2",
  dependencyArchitecture: "dependency-cruiser@18.2.0+zedbee-rules-v1",
  deadCode: "knip@6.32.2+zedbee-managed-config-v1",
  reactCorrectness:
    "eslint@9.39.5+eslint-plugin-react@7.37.5+react-hooks@7.1.1+zedbee-react-calibration-v2",
  reactAccessibility: "eslint@9.39.5+eslint-plugin-jsx-a11y@6.10.2",
} as const);

export type CacheableObservationCheckId = keyof typeof ENGINE_IDENTITIES;

export function observationCacheEngineIdentity(
  checkId: string,
): string | undefined {
  return ENGINE_IDENTITIES[checkId as CacheableObservationCheckId];
}

export function isCacheableObservationCheck(
  checkId: string,
): checkId is CacheableObservationCheckId {
  return observationCacheEngineIdentity(checkId) !== undefined;
}

export interface ObservationCacheKeyInput {
  readonly checkId: string;
  readonly engineIdentity: string;
  readonly policy: Readonly<ResolvedCheckPolicy>;
  readonly target: CheckTarget;
  readonly baselineRoot: string;
  readonly targetRoot: string;
  readonly relevantConfig?: unknown;
  readonly nodeVersion?: string;
  readonly platform?: string;
  readonly arch?: string;
  readonly zedbeeVersion?: string;
}

function targetPolicyPaths(
  paths: readonly string[],
  changeSet: ChangeSet,
): readonly string[] {
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

export function effectiveBehaviorFingerprint(
  config: ResolvedConfig,
  checkId: CheckId,
  paths: readonly string[],
  changeSet: ChangeSet,
): Readonly<{
  repository: unknown;
  files: readonly Readonly<{ path: string; policy: unknown }>[];
}> {
  const policyForFile = createFilePolicyResolver(config, changeSet);
  const files = Object.freeze(
    targetPolicyPaths(paths, changeSet).map((path) =>
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

async function snapshotIdentity(root: string): Promise<readonly unknown[]> {
  const canonicalRoot = await realpath(root);
  const registry = await captureSnapshotRegistry(canonicalRoot);
  const entries = [...registry.entries()].sort((left, right) =>
    compareCodeUnits(left.repositoryPath, right.repositoryPath),
  );
  const limit = pLimit(8);
  return Promise.all(
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
}

export async function createObservationCacheKey(
  input: ObservationCacheKeyInput,
): Promise<string> {
  return createObservationCacheKeyBuilder(
    input.baselineRoot,
    input.targetRoot,
  )(input);
}

type SnapshotBoundKeyInput = Omit<
  ObservationCacheKeyInput,
  "baselineRoot" | "targetRoot"
>;

/** Internal to one dispatch over immutable snapshots; never attach to adapters. */
export function createObservationCacheKeyBuilder(
  baselineRoot: string,
  targetRoot: string,
): (input: SnapshotBoundKeyInput) => Promise<string> {
  let identities:
    Promise<readonly [readonly unknown[], readonly unknown[]]> | undefined;
  return async (input) => {
    // Share in-flight work as well as results. A rejected inventory disables
    // caching for this dispatch; a new dispatch will capture fresh identities.
    const [baseline, target] = await (identities ??= Promise.all([
      snapshotIdentity(baselineRoot),
      snapshotIdentity(targetRoot),
    ]));
    return observationCacheKey(input, baseline, target);
  };
}

function observationCacheKey(
  input: SnapshotBoundKeyInput,
  baseline: readonly unknown[],
  target: readonly unknown[],
): string {
  const payload = stable({
    schema: "zedbee-observation-cache-key-v1",
    checkId: input.checkId,
    engineIdentity: input.engineIdentity,
    policy: input.policy,
    target: input.target,
    baseline,
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
