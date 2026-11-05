import type { FileHandle } from "node:fs/promises";
import { closeSync } from "node:fs";
import { createRequire } from "node:module";

export interface KernelFileLease {
  acquire(): boolean;
  close(): Promise<void>;
}
export interface SynchronousKernelFileLease {
  acquire(): boolean;
  close(): void;
}

const require = createRequire(import.meta.url);
function createAcquirer(
  unavailable: () => Error,
  koffi: typeof import("koffi").default,
): (fd: number) => boolean {
  // RTLD_DEFAULT also works on musl; never emulate kernel ownership with PIDs.
  const flock = koffi.load(null).func("int flock(int fd, int operation)");
  return (fd) => {
    if (flock(fd, 2 | 4) === 0) return true;
    if (koffi.errno() === (process.platform === "darwin" ? 35 : 11))
      return false;
    throw unavailable();
  };
}

/** Takes ownership of a verified, noninherited fd. Never unlink the coordination inode. */
export function openSynchronousKernelFileLease(
  fd: number,
  unavailable: () => Error,
): SynchronousKernelFileLease {
  let closed = false;
  let acquire: ReturnType<typeof createAcquirer> | undefined;
  return {
    acquire() {
      if (closed) throw unavailable();
      return (acquire ??= createAcquirer(
        unavailable,
        require("koffi") as typeof import("koffi").default,
      ))(fd);
    },
    close() {
      if (!closed) {
        closed = true;
        closeSync(fd);
      }
    },
  };
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
  let closed = false;
  let acquire: ReturnType<typeof createAcquirer> | undefined;
  return {
    acquire() {
      if (closed) throw unavailable();
      return (acquire ??= createAcquirer(unavailable, koffi))(file.fd);
    },
    async close() {
      if (!closed) {
        closed = true;
        await file.close();
      }
    },
  };
}
