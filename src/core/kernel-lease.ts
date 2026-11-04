import type { FileHandle } from "node:fs/promises";

export interface KernelFileLease {
  acquire(): boolean;
  close(): Promise<void>;
}

/** Takes ownership of a verified, noninherited fd after successful creation.
 * The caller validates the file and retains responsibility for failed creation.
 * The coordination inode must remain linked while other holders can open it.
 */
export async function openKernelFileLease(
  file: FileHandle,
  unavailable: () => Error,
): Promise<KernelFileLease> {
  const koffi = (await import("koffi")).default;
  // RTLD_DEFAULT also works on musl; never emulate kernel ownership with PIDs.
  const flock = koffi.load(null).func("int flock(int fd, int operation)");
  let closed = false;
  return {
    acquire() {
      if (closed) throw unavailable();
      if (flock(file.fd, 2 | 4) === 0) return true;
      if (koffi.errno() === (process.platform === "darwin" ? 35 : 11))
        return false;
      throw unavailable();
    },
    async close() {
      if (!closed) {
        closed = true;
        await file.close();
      }
    },
  };
}
