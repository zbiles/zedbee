import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { openKernelFileLease } from "../core/kernel-lease.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  isUpdateCacheFresh,
  prepareUpdateDirectory,
  readUpdateCache,
  updateCachePath,
  writeUpdateCache,
} from "./cache.js";
import { fetchLatestMetadata } from "./metadata.js";

async function openRefreshLease(path: string) {
  if (process.platform === "win32")
    return (await import("../service/windows-pipe.js")).openWindowsStateLease(
      path,
    );
  const file = await open(
    path,
    constants.O_CREAT |
      constants.O_RDWR |
      constants.O_NONBLOCK |
      constants.O_NOFOLLOW,
    0o600,
  );
  const unavailable = () => new Error("Update lease unavailable.");
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size !== 0 ||
      stat.uid !== process.getuid!()
    )
      throw unavailable();
    return await openKernelFileLease(file, unavailable);
  } catch (error) {
    await file.close();
    throw error;
  }
}

export async function refreshUpdateCache(
  path: string,
  options: { now?: number; fetcher?: typeof fetch } = {},
): Promise<void> {
  const now = options.now ?? Date.now();
  let lease: Awaited<ReturnType<typeof openRefreshLease>> | undefined;
  try {
    prepareUpdateDirectory(path);
    // Existing versions may unlink .lock. The kernel releases this permanent
    // coordination file automatically if a worker exits before publishing.
    lease = await openRefreshLease(`${path}.refresh.lease`);
    if (!lease.acquire()) return;
    // Another process may have completed a refresh before we acquired the lock.
    const cached = readUpdateCache(path, now);
    if (isUpdateCacheFresh(cached, now)) return;
    const metadata = await fetchLatestMetadata(options.fetcher);
    writeUpdateCache(path, { checkedAt: now, metadata: metadata ?? null });
  } catch {
    // Optional maintenance must never affect scans, including concurrent refreshes.
  } finally {
    try {
      await lease?.close();
    } catch {
      /* Optional background maintenance. */
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
