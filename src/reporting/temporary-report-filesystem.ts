import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  errorCode,
  warning,
  type ReportMaintenanceWarning,
} from "./temporary-report-common.js";

export async function ensureManagedDirectory(
  canonicalParent: string,
  name: string,
  platform: NodeJS.Platform = process.platform,
): Promise<string> {
  const path = join(canonicalParent, name);
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (errorCode(error) !== "EEXIST") throw error;
  });
  const expected = await lstat(path);
  if (!expected.isDirectory() || expected.isSymbolicLink()) {
    throw new TypeError("Managed temporary-report boundary is not a directory");
  }
  if (platform === "win32") {
    const canonicalPath = await realpath(path);
    const current = await lstat(path);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== expected.dev ||
      current.ino !== expected.ino ||
      dirname(canonicalPath) !== canonicalParent
    ) {
      throw new TypeError(
        "Managed temporary-report boundary escapes its parent",
      );
    }
    return canonicalPath;
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    ) {
      throw new TypeError("Managed temporary-report boundary changed");
    }
    await handle.chmod(0o700);
    const canonicalPath = await realpath(path);
    const current = await lstat(path);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      dirname(canonicalPath) !== canonicalParent
    ) {
      throw new TypeError(
        "Managed temporary-report boundary escapes its parent",
      );
    }
    return canonicalPath;
  } finally {
    await handle.close();
  }
}

export async function syncTemporaryReportDirectory(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function atomicReplace(
  directory: string,
  destination: string,
  contents: string,
  warnings: ReportMaintenanceWarning[],
): Promise<void> {
  const temporary = join(directory, `.write-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    renamed = true;
    await syncTemporaryReportDirectory(directory);
  } finally {
    await handle?.close().catch((error: unknown) => {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          `An atomic temporary file could not be closed (${errorCode(error)}).`,
        ),
      );
    });
    if (!renamed) {
      await unlink(temporary).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") {
          warnings.push(
            warning(
              "TEMP_REPORT_CLEANUP_FAILED",
              `An atomic temporary file could not be removed (${errorCode(error)}).`,
            ),
          );
        }
      });
    }
  }
}

export async function readBoundedRegularFile(
  path: string,
  maximumBytes: number,
): Promise<string> {
  const expected = await lstat(path);
  if (
    expected.isSymbolicLink() ||
    !expected.isFile() ||
    expected.size > maximumBytes
  ) {
    throw new TypeError("Invalid temporary-report lifecycle file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size > maximumBytes ||
      metadata.dev !== expected.dev ||
      metadata.ino !== expected.ino
    ) {
      throw new TypeError("Invalid temporary-report lifecycle file");
    }
    const capacity = Math.min(metadata.size + 1, maximumBytes + 1);
    const buffer = Buffer.alloc(capacity);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > maximumBytes || offset > metadata.size) {
      throw new TypeError("Temporary-report lifecycle file changed while read");
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}
