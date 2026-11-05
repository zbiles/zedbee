import { createHash } from "node:crypto";
import { lstat, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import { compareCodeUnits } from "../../core/compare.js";
import { ProjectPrettierFailureError } from "./project-error.js";

/** Hashes all regular mirrored files (sorted path + bytes) for stale-plan checks. */
const IDENTITY_CHUNK_BYTES = 64 * 1024;
const MAX_IDENTITY_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Hashes every regular mirrored file (sorted path and bytes) with fixed
 * memory: files stream through a bounded buffer instead of being loaded in
 * full, so one huge tracked asset cannot exhaust the Zedbee process.
 */
export async function snapshotIdentity(snapshotRoot: string): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(IDENTITY_CHUNK_BYTES);
  const streamFile = async (absolute: string): Promise<void> => {
    const handle = await open(absolute, "r");
    try {
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) return;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  };
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    )) {
      if (entry.name === "node_modules") continue;
      const absolute = join(directory, entry.name);
      const relativePath =
        prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        await walk(absolute, relativePath);
        continue;
      }
      if (!metadata.isFile()) continue;
      if (metadata.size > BigInt(MAX_IDENTITY_FILE_BYTES)) {
        throw new ProjectPrettierFailureError({
          code: "PROJECT_PRETTIER_LAYOUT_UNSUPPORTED",
          message:
            "A snapshot file is too large to fingerprint for stale-plan checks.",
          projectRoot: ".",
        });
      }
      hash.update(relativePath, "utf8");
      hash.update("\0", "utf8");
      await streamFile(absolute);
      hash.update("\0", "utf8");
    }
  };
  await walk(snapshotRoot, "");
  return hash.digest("hex");
}
