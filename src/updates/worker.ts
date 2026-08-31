import { closeSync, lstatSync, openSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareUpdateDirectory,
  readUpdateCache,
  UPDATE_INTERVAL,
  updateCachePath,
  writeUpdateCache,
} from "./cache.js";
import { fetchLatestMetadata } from "./metadata.js";

export async function refreshUpdateCache(
  path: string,
  options: { now?: number; fetcher?: typeof fetch } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  const lock = `${path}.lock`;
  let descriptor: number | undefined;
  try {
    prepareUpdateDirectory(path);
    try {
      const stat = lstatSync(lock);
      if (stat.isFile() && now - stat.mtimeMs > 30_000) unlinkSync(lock);
    } catch {
      /* A missing lock is normal. */
    }
    descriptor = openSync(lock, "wx", 0o600);
    // Another process may have completed a refresh before we acquired the lock.
    const cached = readUpdateCache(path, now);
    if (cached !== undefined && now - cached.checkedAt < UPDATE_INTERVAL)
      return;
    const metadata = await fetchLatestMetadata(options.fetcher);
    writeUpdateCache(path, { checkedAt: now, metadata: metadata ?? null });
  } catch {
    // Optional maintenance must never affect scans, including concurrent refreshes.
  } finally {
    if (descriptor !== undefined) {
      closeSync(descriptor);
      try {
        unlinkSync(lock);
      } catch {
        /* Best effort; stale locks expire. */
      }
    }
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // Parent uses a detached process; this deadline also bounds DNS/body/cache failures.
  const deadline = setTimeout(() => process.exit(0), 5000);
  try {
    await refreshUpdateCache(updateCachePath(process.env));
  } finally {
    clearTimeout(deadline);
  }
}
