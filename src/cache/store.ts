import { createHash, randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { CheckObservationSet, CheckTarget } from "../checks/adapter.js";
import { normalizeObservation } from "../attribution/fingerprint.js";
import { isCacheableObservationCheck } from "../checks/metadata.js";
import { sanitizeCheckTarget } from "../checks/sanitize-target.js";
import { compareCodeUnits } from "../core/compare.js";
import type { Observation } from "../core/types.js";

const KEY = /^[a-f0-9]{64}$/u;

export interface ObservationCache {
  get(key: string): Promise<CheckObservationSet | undefined>;
  set(key: string, value: CheckObservationSet): Promise<void>;
}

export interface ObservationCacheStoreOptions {
  readonly root: string;
  readonly maxEntries?: number;
  readonly maxBytes?: number;
}

interface CachePayload {
  readonly checkId: string;
  readonly target: CheckTarget;
  readonly baselineObservations: readonly Observation[];
  readonly targetObservations: readonly Observation[];
  readonly projectDelta?: boolean;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function sanitizeCacheableObservationSet(
  value: CheckObservationSet,
): CachePayload {
  if (typeof value !== "object" || value === null) throw new TypeError();
  const input = value as unknown as Record<string, unknown>;
  if (
    typeof input.checkId !== "string" ||
    input.checkId.length === 0 ||
    !isCacheableObservationCheck(input.checkId) ||
    !Array.isArray(input.baselineObservations) ||
    !Array.isArray(input.targetObservations) ||
    (input.projectDelta !== undefined &&
      typeof input.projectDelta !== "boolean")
  ) {
    throw new TypeError();
  }
  const baselineObservations = input.baselineObservations.map((item) =>
    normalizeObservation(item as Observation),
  );
  const targetObservations = input.targetObservations.map((item) =>
    normalizeObservation(item as Observation),
  );
  if (
    [...baselineObservations, ...targetObservations].some(
      (observation) => observation.check !== input.checkId,
    )
  ) {
    throw new TypeError();
  }
  return Object.freeze({
    checkId: input.checkId,
    target: sanitizeCheckTarget(input.target as CheckTarget),
    baselineObservations: Object.freeze(baselineObservations),
    targetObservations: Object.freeze(targetObservations),
    ...(input.projectDelta === undefined
      ? {}
      : { projectDelta: input.projectDelta }),
  });
}

export function defaultObservationCacheRoot(
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const xdg = environment.XDG_CACHE_HOME;
  if (xdg !== undefined && isAbsolute(xdg)) {
    return join(xdg, "zedbee", "observations");
  }
  const localAppData = environment.LOCALAPPDATA;
  if (
    platform === "win32" &&
    localAppData !== undefined &&
    isAbsolute(localAppData)
  ) {
    return join(localAppData, "zedbee", "observations");
  }
  return platform === "darwin"
    ? join(home, "Library", "Caches", "zedbee", "observations")
    : join(home, ".cache", "zedbee", "observations");
}

export class ObservationCacheStore implements ObservationCache {
  readonly root: string;
  readonly maxEntries: number;
  readonly maxBytes: number;

  constructor(options: ObservationCacheStoreOptions) {
    this.root = options.root;
    this.maxEntries = options.maxEntries ?? 256;
    this.maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
    if (
      !Number.isSafeInteger(this.maxEntries) ||
      this.maxEntries < 1 ||
      !Number.isSafeInteger(this.maxBytes) ||
      this.maxBytes < 1024
    ) {
      throw new TypeError("Invalid cache bounds");
    }
  }

  private path(key: string): string {
    if (!KEY.test(key)) throw new TypeError("Invalid observation cache key");
    return join(this.root, `${key}.json`);
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const metadata = await lstat(this.root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new TypeError("Invalid observation cache root");
    }
  }

  async get(key: string): Promise<CheckObservationSet | undefined> {
    try {
      const rootMetadata = await lstat(this.root);
      if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
        return undefined;
      }
      const path = this.path(key);
      const metadata = await lstat(path);
      if (
        !metadata.isFile() ||
        metadata.isSymbolicLink() ||
        metadata.size > this.maxBytes
      ) {
        return undefined;
      }
      const serialized = await readFile(path, "utf8");
      const envelope = JSON.parse(serialized) as Record<string, unknown>;
      const payloadText = JSON.stringify(envelope.payload);
      if (
        envelope.schemaVersion !== 2 ||
        typeof envelope.integrity !== "string" ||
        envelope.integrity !== digest(payloadText)
      ) {
        return undefined;
      }
      const payload = sanitizeCacheableObservationSet(
        envelope.payload as unknown as CheckObservationSet,
      );
      const now = new Date();
      await utimes(path, now, now).catch(() => undefined);
      return payload;
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: CheckObservationSet): Promise<void> {
    let temporary: string | undefined;
    try {
      const payload = sanitizeCacheableObservationSet(value);
      const payloadText = JSON.stringify(payload);
      const serialized = `${JSON.stringify({
        schemaVersion: 2,
        integrity: digest(payloadText),
        payload,
      })}\n`;
      if (Buffer.byteLength(serialized) > this.maxBytes) return;
      await this.ensureRoot();
      const destination = this.path(key);
      temporary = join(
        this.root,
        `.${key}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
      );
      await writeFile(temporary, serialized, { flag: "wx", mode: 0o600 });
      await rename(temporary, destination);
      temporary = undefined;
      await this.prune();
    } catch {
      // Cache failures never reduce scan coverage or change scan outcomes.
    } finally {
      if (temporary !== undefined) {
        await unlink(temporary).catch(() => undefined);
      }
    }
  }

  private async prune(): Promise<void> {
    const names = (await readdir(this.root)).filter((name) =>
      /^[a-f0-9]{64}\.json$/u.test(name),
    );
    const entries = (
      await Promise.all(
        names.map(async (name) => {
          const path = join(this.root, name);
          const metadata = await lstat(path);
          return metadata.isFile() && !metadata.isSymbolicLink()
            ? { name, path, size: metadata.size, mtimeMs: metadata.mtimeMs }
            : undefined;
        }),
      )
    )
      .filter((entry) => entry !== undefined)
      .sort(
        (left, right) =>
          left.mtimeMs - right.mtimeMs ||
          compareCodeUnits(left.name, right.name),
      );
    let bytes = entries.reduce((total, entry) => total + entry.size, 0);
    while (entries.length > this.maxEntries || bytes > this.maxBytes) {
      const oldest = entries.shift();
      if (oldest === undefined) break;
      const metadata = await lstat(oldest.path);
      if (!metadata.isFile() || metadata.isSymbolicLink()) continue;
      await unlink(oldest.path);
      bytes -= oldest.size;
    }
  }
}
