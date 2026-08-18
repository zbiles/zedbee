import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { createObservationCacheKey } from "../../src/cache/key.js";
import { ObservationCacheStore } from "../../src/cache/store.js";
import { createInspectionFixture } from "../inspection/fixture.js";

async function key(options: {
  targetSource?: string;
  max?: number;
  engine?: string;
  relevantConfig?: Readonly<Record<string, unknown>>;
  nodeVersion?: string;
  platform?: string;
  arch?: string;
  zedbeeVersion?: string;
  lockfileSource?: string;
}) {
  const [baseline, target] = await Promise.all([
    createInspectionFixture(),
    createInspectionFixture(),
  ]);
  await baseline.write("src/value.ts", "export const value = 1;\n");
  await target.write(
    "src/value.ts",
    options.targetSource ?? "export const value = 2;\n",
  );
  await baseline.write("package-lock.json", '{"lockfileVersion":3}\n');
  await target.write(
    "package-lock.json",
    options.lockfileSource ?? '{"lockfileVersion":3}\n',
  );
  return createObservationCacheKey({
    checkId: "cyclomaticComplexity",
    engineIdentity: options.engine ?? "zedbee-cyclomatic-v1",
    policy: {
      severity: "error",
      when: "relevant",
      max: options.max ?? 20,
      blockWorsening: true,
    },
    target: { id: ".", kind: "repository", relativeRoot: "." },
    baselineRoot: baseline.root,
    targetRoot: target.root,
    relevantConfig: options.relevantConfig ?? {
      packageManager: "npm",
      workspace: ".",
      lockfiles: ["package-lock.json"],
    },
    nodeVersion: options.nodeVersion ?? "24.0.0",
    platform: options.platform ?? "linux",
    arch: options.arch ?? "x64",
    zedbeeVersion: options.zedbeeVersion ?? "0.1.0",
  });
}

async function cacheRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

describe("observation cache", () => {
  it("keys immutable snapshot content, policy, engine, runtime, and target", async () => {
    const original = await key({});
    expect(await key({})).toBe(original);
    expect(await key({ targetSource: "export const value = 3;\n" })).not.toBe(
      original,
    );
    expect(await key({ max: 21 })).not.toBe(original);
    expect(await key({ engine: "zedbee-cyclomatic-v2" })).not.toBe(original);
    expect(await key({ relevantConfig: { packageManager: "pnpm" } })).not.toBe(
      original,
    );
    expect(await key({ nodeVersion: "25.0.0" })).not.toBe(original);
    expect(await key({ platform: "darwin" })).not.toBe(original);
    expect(await key({ arch: "arm64" })).not.toBe(original);
    expect(await key({ zedbeeVersion: "0.1.1" })).not.toBe(original);
    expect(
      await key({
        lockfileSource:
          '{"lockfileVersion":3,"packages":{"node_modules/example":{}}}\n',
      }),
    ).not.toBe(original);
  });

  it("keys multi-chunk snapshot files deterministically", async () => {
    const largeSource = "x".repeat(200_000);
    const original = await key({ targetSource: largeSource });

    expect(await key({ targetSource: largeSource })).toBe(original);
    expect(
      await key({ targetSource: `${largeSource.slice(0, -1)}y` }),
    ).not.toBe(original);
  });

  it("stores only validated observations and treats corruption as a miss", async () => {
    const root = await cacheRoot("zedbee-cache-test-");
    const store = new ObservationCacheStore({
      root,
      maxEntries: 4,
      maxBytes: 1_000_000,
    });
    const cacheKey = "a".repeat(64);
    const value = {
      checkId: "cyclomaticComplexity",
      target: { id: ".", kind: "repository" as const, relativeRoot: "." },
      baselineObservations: [],
      targetObservations: [
        {
          check: "cyclomaticComplexity",
          rule: "max",
          identity: "function:src/value.ts:run",
          severity: "error" as const,
          message: "Complexity is 21.",
          entity: { kind: "function", name: "run", file: "src/value.ts" },
          metric: { name: "cyclomatic-complexity", value: 21, limit: 20 },
        },
      ],
    };

    await store.set(cacheKey, {
      ...value,
      rawOutput: "must not persist",
    } as typeof value & { rawOutput: string });
    await expect(store.get(cacheKey)).resolves.toEqual(value);
    const path = join(root, `${cacheKey}.json`);
    const serialized = await readFile(path, "utf8");
    expect(serialized).not.toContain("snapshotRoot");
    expect(serialized).not.toContain("rawOutput");
    await writeFile(path, `${serialized.slice(0, -2)}x`);
    await expect(store.get(cacheKey)).resolves.toBeUndefined();
  });

  it("prunes least-recently-used entries to the configured bound", async () => {
    const root = await cacheRoot("zedbee-cache-prune-");
    const store = new ObservationCacheStore({
      root,
      maxEntries: 1,
      maxBytes: 1_000_000,
    });
    const empty = {
      checkId: "structuralSecurity",
      target: { id: ".", kind: "repository" as const, relativeRoot: "." },
      baselineObservations: [],
      targetObservations: [],
    };
    await store.set("a".repeat(64), empty);
    await store.set("b".repeat(64), empty);

    await expect(store.get("a".repeat(64))).resolves.toBeUndefined();
    await expect(store.get("b".repeat(64))).resolves.toEqual(empty);
  });

  it.each(["secrets", "vulnerabilities"])(
    "never persists %s observations",
    async (checkId) => {
      const root = await cacheRoot("zedbee-cache-sensitive-");
      const store = new ObservationCacheStore({ root });
      const cacheKey = "c".repeat(64);

      await store.set(cacheKey, {
        checkId,
        target: { id: ".", kind: "repository", relativeRoot: "." },
        baselineObservations: [],
        targetObservations: [
          {
            check: checkId,
            rule: "sensitive",
            identity: "sensitive:1",
            severity: "error",
            message: "sensitive package or secret metadata",
          },
        ],
      });

      await expect(store.get(cacheKey)).resolves.toBeUndefined();
    },
  );

  it("treats filesystem failures as cache misses", async () => {
    const parent = await cacheRoot("zedbee-cache-failure-");
    const root = join(parent, "cache-file");
    await writeFile(root, "not a directory");
    const store = new ObservationCacheStore({ root });

    await expect(store.get("d".repeat(64))).resolves.toBeUndefined();
    await expect(
      store.set("d".repeat(64), {
        checkId: "lint",
        target: { id: ".", kind: "repository", relativeRoot: "." },
        baselineObservations: [],
        targetObservations: [],
      }),
    ).resolves.toBeUndefined();
  });
});
