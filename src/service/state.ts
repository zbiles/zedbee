import { constants, type BigIntStats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, join, parse } from "node:path";
import { randomBytes } from "node:crypto";
import { exactFields } from "../checks/runner/envelope.js";
import { HEX, ServiceUnavailableError } from "./protocol.js";

export interface ServiceRecord {
  readonly version: 1;
  readonly identity: string;
  readonly instance: string;
  readonly secret: string;
}
export interface StateLease {
  acquire(): boolean;
  close(): Promise<void>;
}
function validRecord(value: unknown): value is ServiceRecord {
  return (
    exactFields(value, ["version", "identity", "instance", "secret"]) &&
    value.version === 1 &&
    [value.identity, value.instance, value.secret].every(
      (v) => typeof v === "string" && HEX.test(v),
    )
  );
}
function same(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}
function owned(stat: BigIntStats, directory: boolean): void {
  if (
    !(directory ? stat.isDirectory() : stat.isFile()) ||
    stat.isSymbolicLink() ||
    (!directory && stat.nlink !== 1n) ||
    (process.platform !== "win32" &&
      (stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o077n) !== 0n))
  )
    throw new ServiceUnavailableError();
}

/** State never contains project paths, source, jobs, diagnostics or PID authority. */
export class ServiceState {
  constructor(readonly directory: string) {
    if (!isAbsolute(directory) || directory === parse(directory).root)
      throw new ServiceUnavailableError();
  }
  private async ancestry(): Promise<void> {
    const paths: string[] = [];
    for (let path = dirname(this.directory); ; path = dirname(path)) {
      paths.push(path);
      if (path === dirname(path)) break;
    }
    for (const path of paths.reverse()) {
      const stat = await lstat(path, { bigint: true });
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new ServiceUnavailableError();
      if (process.platform === "win32")
        (await import("./windows-pipe.js")).verifyWindowsPath(path, false);
      else if ((stat.mode & 0o022n) !== 0n && (stat.mode & 0o1000n) === 0n)
        throw new ServiceUnavailableError();
    }
  }
  private async checkDirectory(): Promise<void> {
    await this.ancestry();
    owned(await lstat(this.directory, { bigint: true }), true);
    if ((await realpath(this.directory)) !== this.directory)
      throw new ServiceUnavailableError();
    if (process.platform === "win32")
      (await import("./windows-pipe.js")).verifyWindowsPath(
        this.directory,
        true,
      );
  }
  async prepare(): Promise<void> {
    await this.ancestry();
    if (process.platform === "win32")
      (await import("./windows-pipe.js")).createWindowsDirectory(
        this.directory,
      );
    else
      await mkdir(this.directory, { mode: 0o700 }).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
    await this.checkDirectory();
  }
  private async checkedFile(path: string, create = false): Promise<FileHandle> {
    await this.checkDirectory();
    if (process.platform === "win32")
      (await import("./windows-pipe.js")).verifyWindowsPath(path, true);
    const file = await open(
      path,
      constants.O_NOFOLLOW |
        (create ? constants.O_CREAT | constants.O_RDWR : constants.O_RDONLY),
      0o600,
    );
    try {
      const stat = await file.stat({ bigint: true });
      owned(stat, false);
      if (!same(stat, await lstat(path, { bigint: true })))
        throw new ServiceUnavailableError();
      await this.checkDirectory();
      return file;
    } catch (error) {
      await file.close();
      throw error;
    }
  }
  async read(): Promise<ServiceRecord | undefined> {
    let file: FileHandle;
    const path = join(this.directory, "endpoint.json");
    try {
      file = await this.checkedFile(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new ServiceUnavailableError();
    }
    try {
      const before = await file.stat({ bigint: true });
      if (before.size > 8192n) throw new ServiceUnavailableError();
      const bytes = Buffer.alloc(8193);
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
      const after = await file.stat({ bigint: true });
      if (
        bytesRead > 8192 ||
        BigInt(bytesRead) !== before.size ||
        before.mtimeNs !== after.mtimeNs ||
        before.ctimeNs !== after.ctimeNs ||
        !same(after, await lstat(path, { bigint: true }))
      )
        throw new ServiceUnavailableError();
      const value: unknown = JSON.parse(bytes.toString("utf8", 0, bytesRead));
      if (!validRecord(value)) throw new ServiceUnavailableError();
      return value;
    } catch {
      throw new ServiceUnavailableError();
    } finally {
      await file.close();
    }
  }
  async lease(id?: string, create = true): Promise<StateLease> {
    if (id !== undefined && !HEX.test(id)) throw new ServiceUnavailableError();
    return this.leaseFile(
      id === undefined ? "owner.lock" : `io-${id}.lock`,
      create,
    );
  }
  private async leaseFile(name: string, create: boolean): Promise<StateLease> {
    await this.checkDirectory();
    const path = join(this.directory, name);
    if (process.platform === "win32") {
      const lease = (await import("./windows-pipe.js")).openWindowsStateLease(
        path,
        create,
      );
      return {
        acquire: lease.acquire,
        close: async () => {
          lease.close();
        },
      };
    }
    const file = await this.checkedFile(path, create);
    try {
      if ((await file.stat()).size !== 0) throw new ServiceUnavailableError();
      const koffi = (await import("koffi")).default;
      // Noninherited Node fd; LOCK_EX|LOCK_NB, never shell flock or PID guesses.
      // Koffi maps null to RTLD_DEFAULT: use the runtime's already-loaded
      // native flock symbol without assuming glibc's filename on musl Linux.
      // Missing native symbols remain pre-acceptance unavailable, not emulated.
      const libc = koffi.load(null);
      const flock = libc.func("int flock(int fd, int operation)");
      let closed = false;
      return {
        acquire() {
          if (closed) throw new ServiceUnavailableError();
          if (flock(file.fd, 2 | 4) === 0) return true;
          if (koffi.errno() === (process.platform === "darwin" ? 35 : 11))
            return false;
          throw new ServiceUnavailableError();
        },
        async close() {
          if (!closed) {
            closed = true;
            await file.close();
          }
        },
      };
    } catch (error) {
      await file.close().catch(() => {});
      throw error;
    }
  }
  async lock(): Promise<(() => Promise<void>) | undefined> {
    const lease = await this.lease();
    try {
      if (lease.acquire()) return () => lease.close();
    } catch (error) {
      await lease.close();
      throw error;
    }
    await lease.close();
    return undefined;
  }
  async removeLease(id: string): Promise<void> {
    if (!HEX.test(id)) throw new ServiceUnavailableError();
    const path = join(this.directory, `io-${id}.lock`);
    // All removers release their original I/O lease before taking this lock.
    // Serialize verification handles with deletion across processes; this
    // permanent coordination file, like owner.lock, must never be unlinked.
    const removal = await this.leaseFile("removal.lock", true);
    try {
      while (!removal.acquire())
        await new Promise((resolve) => setTimeout(resolve, 20));
      try {
        const file = await this.checkedFile(path);
        try {
          if ((await file.stat()).size !== 0)
            throw new ServiceUnavailableError();
        } finally {
          await file.close();
        }
        await unlink(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    } finally {
      await removal.close();
    }
  }
  async publish(value: ServiceRecord): Promise<void> {
    if (!validRecord(value)) throw new ServiceUnavailableError();
    await this.checkDirectory();
    const temporary = join(
      this.directory,
      `publish-${randomBytes(16).toString("hex")}`,
    );
    const file = await open(
      temporary,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    );
    try {
      if (process.platform === "win32")
        (await import("./windows-pipe.js")).restrictCreatedWindowsPath(
          temporary,
        );
      await file.writeFile(JSON.stringify(value));
      await file.sync();
    } finally {
      await file.close();
    }
    try {
      await this.checkDirectory();
      await rename(temporary, join(this.directory, "endpoint.json"));
    } finally {
      await unlink(temporary).catch((error) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
  }
  async clear(instance: string): Promise<void> {
    if ((await this.read())?.instance === instance)
      await unlink(join(this.directory, "endpoint.json"));
  }
}
