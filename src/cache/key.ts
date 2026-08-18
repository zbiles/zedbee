import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readlink, realpath } from "node:fs/promises";
import pLimit from "p-limit";
import type { CheckTarget } from "../checks/adapter.js";
import type { ResolvedCheckPolicy } from "../config/schema.js";
import { compareCodeUnits } from "../core/compare.js";
import { captureSnapshotRegistry } from "../inspection/snapshot-registry.js";

const ENGINE_IDENTITIES = Object.freeze({
  lint: "eslint@9.39.5+typescript-eslint@8.67.0+zedbee-rules-v1",
  types: "typescript@6.0.3+zedbee-program-v1",
  cyclomaticComplexity: "eslint@9.39.5+complexity-v1",
  readabilityComplexity: "eslint@9.39.5+zedbee-readability-v1",
  structuralSecurity: "ast-grep@0.45.1+zedbee-structural-rules-v1",
  duplication: "jscpd@5.0.15+zedbee-clone-normalization-v1",
  dependencyArchitecture: "dependency-cruiser@18.2.0+zedbee-rules-v1",
  deadCode: "knip@6.32.2+zedbee-managed-config-v1",
  reactCorrectness:
    "eslint@9.39.5+eslint-plugin-react@7.37.5+react-hooks@7.1.1",
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
  const [baseline, target] = await Promise.all([
    snapshotIdentity(input.baselineRoot),
    snapshotIdentity(input.targetRoot),
  ]);
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
  });
  return createHash("sha256")
    .update(JSON.stringify(payload), "utf8")
    .digest("hex");
}
