import { openKernelFileLease } from "../core/kernel-lease.js";
import { constants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { validateTemporaryReportPath } from "./report-path.js";
import {
  errorCode,
  warning,
  type ReportMaintenanceWarning,
} from "./temporary-report-common.js";

export const LOCK_FILE_NAME = ".lifecycle.lock";
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;

interface Lease {
  acquire(): boolean;
  close(): Promise<void> | void;
}
export interface OwnedLock {
  readonly lease: Lease;
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}
export class LockTimeoutError extends Error {
  readonly code = "LOCK_TIMEOUT";
  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

async function validateIdentity(lock: OwnedLock): Promise<void> {
  const metadata = await lstat(lock.path);
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    metadata.nlink !== 1 ||
    metadata.size !== 0 ||
    metadata.dev !== lock.device ||
    metadata.ino !== lock.inode
  ) {
    throw new TypeError("Temporary-report lock identity changed");
  }
}

async function openLease(path: string): Promise<OwnedLock> {
  if (process.platform === "win32") {
    // LockFileEx owns a noninherited, ACL-verified handle that denies deletion.
    const lease = (
      await import("../service/windows-pipe.js")
    ).openWindowsStateLease(path);
    try {
      const metadata = await lstat(path);
      const lock = { lease, path, device: metadata.dev, inode: metadata.ino };
      await validateIdentity(lock);
      return lock;
    } catch (error) {
      lease.close();
      throw error;
    }
  }
  let file: FileHandle | undefined = await open(
    path,
    constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    const metadata = await file.stat();
    if (
      !metadata.isFile() ||
      metadata.nlink !== 1 ||
      metadata.size !== 0 ||
      metadata.uid !== process.getuid!()
    ) {
      throw new TypeError("Invalid temporary-report lock file");
    }
    const handle = file;
    const lease = await openKernelFileLease(
      handle,
      () => new Error("Unable to lock temporary reports"),
    );
    const lock = { lease, path, device: metadata.dev, inode: metadata.ino };
    await validateIdentity(lock);
    await handle.chmod(0o600);
    file = undefined;
    return lock;
  } finally {
    await file?.close();
  }
}

export async function acquireLock(
  repositoryDirectory: string,
  warnings: ReportMaintenanceWarning[],
): Promise<OwnedLock> {
  const lock = await openLease(join(repositoryDirectory, LOCK_FILE_NAME));
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  try {
    for (;;) {
      if (lock.lease.acquire()) {
        await validateIdentity(lock);
        return lock;
      }
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        await validateIdentity(lock);
        throw new LockTimeoutError(
          "Temporary-report lock timed out",
          validateTemporaryReportPath(lock.path),
        );
      }
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(LOCK_RETRY_MS, remaining)),
      );
    }
  } catch (error) {
    await releaseLock(lock, warnings);
    throw error;
  }
}

export async function releaseLock(
  lock: OwnedLock,
  warnings: ReportMaintenanceWarning[],
): Promise<void> {
  try {
    await validateIdentity(lock);
  } catch (error) {
    warnings.push(
      warning(
        "TEMP_REPORT_CLEANUP_FAILED",
        `The owned temporary-report lock could not be validated (${errorCode(error)}); it was left untouched.`,
      ),
    );
  } finally {
    try {
      await lock.lease.close();
    } catch (error) {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          `The owned temporary-report lock could not be closed (${errorCode(error)}).`,
        ),
      );
    }
  }
  // Keep this inode permanently. Unlinking permits another process to lock a
  // replacement inode while existing waiters still hold the previous one.
}
