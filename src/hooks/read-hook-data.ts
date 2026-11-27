import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { hasHookExecutePermission } from "./install.js";

const MAX_BYTES = 64 * 1024;

/** Optional, bounded, data-only reads. Never follow a hook symlink. */
export async function readHookData(
  path: string,
  requireExecutable = false,
): Promise<string | undefined> {
  try {
    if ((await realpath(path)) !== path) return undefined;
    const before = await lstat(path);
    if (!before.isFile() || before.size > MAX_BYTES) return undefined;
    const file = await open(
      path,
      constants.O_RDONLY |
        (constants.O_NOFOLLOW ?? 0) |
        (constants.O_NONBLOCK ?? 0),
    );
    try {
      const state = await file.stat();
      if (
        !state.isFile() ||
        state.size > MAX_BYTES ||
        (requireExecutable && !hasHookExecutePermission(state.mode))
      )
        return undefined;
      const bytes = Buffer.alloc(MAX_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const read = await file.read(
          bytes,
          length,
          bytes.length - length,
          null,
        );
        if (read.bytesRead === 0) return bytes.toString("utf8", 0, length);
        length += read.bytesRead;
      }
      return undefined;
    } finally {
      await file.close();
    }
  } catch {
    return undefined;
  }
}
