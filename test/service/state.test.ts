import { afterEach, describe, expect, it, vi } from "vitest";
import koffi from "koffi";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServiceState } from "../../src/service/state.js";

const roots: string[] = [];
async function root() {
  const value = await realpath(
    await mkdtemp(join(tmpdir(), "zedbee-service-state-")),
  );
  roots.push(value);
  return value;
}
afterEach(async () => {
  for (const path of roots.splice(0))
    await rm(path, { recursive: true, force: true });
});
describe("private service state ownership", () => {
  it.skipIf(process.platform === "win32")(
    "uses the runtime's existing flock symbol without requiring a glibc library name",
    async () => {
      const original = koffi.load;
      const load = vi
        .spyOn(koffi, "load")
        .mockImplementation((path, options) => {
          expect(path).toBeNull();
          return options === undefined
            ? original(path)
            : original(path, options);
        });
      const state = new ServiceState(join(await root(), "state"));
      try {
        await state.prepare();
        const release = await state.lock();
        expect(release).toBeDefined();
        await release!();
      } finally {
        load.mockRestore();
      }
    },
  );
  it("permits both authenticated lease owners to finish removal without unlinking startup ownership", async () => {
    const state = new ServiceState(join(await root(), "state"));
    await state.prepare();
    const lock = await state.lock();
    const id = "d".repeat(64);
    const lease = await state.lease(id);
    expect(lease.acquire()).toBe(true);
    await lease.close();
    await state.removeLease(id);
    await expect(state.removeLease(id)).resolves.toBeUndefined();
    await expect(
      lstat(join(state.directory, "owner.lock")),
    ).resolves.toBeDefined();
    await lock!();
  });
  it("serializes competing removal through the exact lease's completed unlink", async () => {
    const state = new ServiceState(join(await root(), "state"));
    const other = new ServiceState(state.directory);
    await state.prepare();
    const owner = await state.lock();
    const id = "e".repeat(64);
    const lease = await state.lease(id);
    await lease.close();
    let resume!: () => void, entered!: () => void, contended!: () => void;
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const inspected = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const contention = new Promise<void>((resolve) => {
      contended = resolve;
    });
    // Hold a real checked handle in the first remover. The second must wait
    // for kernel ownership, not race this handle with its own deletion.
    const original = (state as any).checkedFile.bind(state);
    const checked = vi
      .spyOn(state as any, "checkedFile")
      .mockImplementation(async (...args) => {
        const file = await original(...args);
        if (args[0] === join(state.directory, `io-${id}.lock`)) {
          entered();
          await gate;
        }
        return file;
      });
    let restoreNative: () => void;
    if (process.platform === "win32") {
      const native = await import("../../src/service/windows-pipe.js");
      const originalLease = native.openWindowsStateLease;
      const spy = vi
        .spyOn(native, "openWindowsStateLease")
        .mockImplementation((...args) => {
          const value = originalLease(...args);
          return {
            ...value,
            acquire() {
              const acquired = value.acquire();
              if (!acquired) contended();
              return acquired;
            },
          };
        });
      restoreNative = () => spy.mockRestore();
    } else {
      const originalLoad = koffi.load;
      const spy = vi
        .spyOn(koffi, "load")
        .mockImplementation((path, options) => {
          const library =
            options === undefined
              ? originalLoad(path)
              : originalLoad(path, options);
          return {
            ...library,
            func: (...args: any[]) => {
              const fn = (library.func as any)(...args);
              return (...values: any[]) => {
                const result = fn(...values);
                if (result !== 0) contended();
                return result;
              };
            },
          } as typeof library;
        });
      restoreNative = () => spy.mockRestore();
    }
    const first = state.removeLease(id);
    let second: Promise<void> | undefined;
    try {
      await inspected;
      let settled = false;
      second = other.removeLease(id).finally(() => {
        settled = true;
      });
      await Promise.race([contention, second.catch(() => {})]);
      expect(settled).toBe(false);
      await expect(
        lstat(join(state.directory, `io-${id}.lock`)),
      ).resolves.toBeDefined();
      resume();
      await Promise.all([first, second]);
      await expect(
        lstat(join(state.directory, `io-${id}.lock`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        lstat(join(state.directory, "owner.lock")),
      ).resolves.toBeDefined();
      await expect(
        lstat(join(state.directory, "removal.lock")),
      ).resolves.toBeDefined();
    } finally {
      resume();
      await Promise.allSettled([first, ...(second ? [second] : [])]);
      checked.mockRestore();
      restoreNative();
      await owner!();
    }
  });
  it("rejects a corrupt removal lock without deleting the target lease", async () => {
    const state = new ServiceState(join(await root(), "state"));
    await state.prepare();
    const id = "c".repeat(64);
    await state.removeLease(id);
    const lease = await state.lease(id);
    await lease.close();
    await writeFile(join(state.directory, "removal.lock"), "corrupt");
    await expect(state.removeLease(id)).rejects.toThrow();
    await expect(
      lstat(join(state.directory, `io-${id}.lock`)),
    ).resolves.toBeDefined();
  });
  it("preserves a real verification failure and releases removal ownership", async () => {
    const state = new ServiceState(join(await root(), "state"));
    await state.prepare();
    const id = "b".repeat(64);
    const path = join(state.directory, `io-${id}.lock`);
    const lease = await state.lease(id);
    await lease.close();
    const original = (state as any).checkedFile.bind(state);
    const checked = vi
      .spyOn(state as any, "checkedFile")
      .mockImplementation(async (...args) => {
        if (args[0] === path)
          throw Object.assign(new Error("Permission denied"), {
            code: "EACCES",
          });
        return original(...args);
      });
    try {
      await expect(state.removeLease(id)).rejects.toMatchObject({
        code: "EACCES",
      });
      await expect(lstat(path)).resolves.toBeDefined();
    } finally {
      checked.mockRestore();
    }
    await state.removeLease(id);
    await expect(lstat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("does not create discovery state on read and keeps secret metadata owner-only", async () => {
    const directory = join(await root(), "state");
    const state = new ServiceState(directory);
    expect(await state.read()).toBeUndefined();
    await expect(lstat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    await state.prepare();
    const lock = await state.lock();
    expect(lock).toBeDefined();
    try {
      await state.publish({
        version: 1,
        identity: "a".repeat(64),
        instance: "b".repeat(64),
        secret: "c".repeat(64),
      });
      expect((await state.read())?.identity).toBe("a".repeat(64));
      if (process.platform !== "win32") {
        expect((await lstat(directory)).mode & 0o777).toBe(0o700);
        expect(
          (await lstat(join(directory, "endpoint.json"))).mode & 0o777,
        ).toBe(0o600);
      }
      expect((await lstat(join(directory, "owner.lock"))).size).toBe(0);
    } finally {
      await lock?.();
    }
    // LockFileEx is mandatory: ordinary ReadFile overlaps the exclusive byte
    // range even for an empty file. Verify its bytes after releasing the lock.
    expect(await readFile(join(directory, "owner.lock"))).toHaveLength(0);
  });
  it.each([
    "remove-after-read",
    "remove-after-stat",
    "replace",
    "link",
    "read-error",
  ])("handles discovery changing during a checked read: %s", async (change) => {
    const parent = await root();
    const state = new ServiceState(join(parent, "state"));
    await state.prepare();
    const release = await state.lock();
    const record = {
      version: 1 as const,
      identity: "a".repeat(64),
      instance: "b".repeat(64),
      secret: "c".repeat(64),
    };
    await state.publish(record);
    const endpoint = join(state.directory, "endpoint.json");
    const target = join(parent, "outside.json");
    await writeFile(target, JSON.stringify(record), { mode: 0o600 });
    let handle: FileHandle | undefined;
    const original = (state as any).checkedFile.bind(state);
    const checked = vi
      .spyOn(state as any, "checkedFile")
      .mockImplementation(async (...args) => {
        const file: FileHandle = await original(...args);
        if (args[0] !== endpoint) return file;
        handle = file;
        const read = file.read.bind(file);
        vi.spyOn(file, "read").mockImplementation((async (
          ...parameters: any[]
        ) => {
          if (change === "read-error")
            throw Object.assign(new Error("Read failed"), { code: "ENOENT" });
          const result = await (read as any)(...parameters);
          if (change === "remove-after-read" || change === "link")
            await unlink(endpoint);
          if (change === "replace")
            await state.publish({ ...record, identity: "d".repeat(64) });
          if (change === "link") await symlink(target, endpoint);
          return result;
        }) as typeof file.read);
        if (change === "remove-after-stat") {
          const stat = file.stat.bind(file);
          let calls = 0;
          vi.spyOn(file, "stat").mockImplementation((async (
            ...parameters: any[]
          ) => {
            const result = await (stat as any)(...parameters);
            if (++calls === 2) await unlink(endpoint);
            return result;
          }) as typeof file.stat);
        }
        return file;
      });
    try {
      if (change.startsWith("remove-")) {
        await expect(state.read()).resolves.toBeUndefined();
        const contender = await new ServiceState(state.directory).lock();
        try {
          expect(contender).toBeUndefined();
        } finally {
          await contender?.();
        }
      } else await expect(state.read()).rejects.toThrow();
      expect(handle?.fd).toBe(-1);
      expect(await readFile(target, "utf8")).toBe(JSON.stringify(record));
    } finally {
      checked.mockRestore();
      await handle?.close();
      await release!();
    }
  });
  it("admits one kernel-lock owner and releases contention when the handle closes", async () => {
    const directory = join(await root(), "state");
    const first = new ServiceState(directory),
      second = new ServiceState(directory);
    await first.prepare();
    await second.prepare();
    const release = await first.lock();
    expect(release).toBeDefined();
    expect(await second.lock()).toBeUndefined();
    await release!();
    const again = await second.lock();
    expect(again).toBeDefined();
    await again!();
  });
  it("rejects directory and metadata links without reading or changing the destination", async () => {
    const parent = await root();
    const other = join(parent, "other");
    await mkdir(other);
    const directory = join(parent, "state");
    await symlink(other, directory, "junction");
    await expect(new ServiceState(directory).prepare()).rejects.toThrow();
    await rm(directory);
    const state = new ServiceState(directory);
    await state.prepare();
    const target = join(parent, "outside");
    await writeFile(target, "do not modify");
    await symlink(target, join(directory, "endpoint.json"));
    await expect(state.read()).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("do not modify");
  });
  it.skipIf(process.platform === "win32")(
    "rejects permissive existing state instead of repairing its trust",
    async () => {
      const directory = join(await root(), "state");
      await mkdir(directory, { mode: 0o755 });
      await chmod(directory, 0o755);
      await expect(new ServiceState(directory).prepare()).rejects.toThrow();
      expect((await lstat(directory)).mode & 0o777).toBe(0o755);
    },
  );
  it("rejects malformed, oversized and unknown-field metadata", async () => {
    const directory = join(await root(), "state");
    const state = new ServiceState(directory);
    await state.prepare();
    for (const value of [
      "{",
      "x".repeat(9000),
      JSON.stringify({
        version: 1,
        identity: "a".repeat(64),
        instance: "b".repeat(64),
        secret: "c".repeat(64),
        source: "private",
      }),
    ]) {
      await writeFile(join(directory, "endpoint.json"), value, { mode: 0o600 });
      await expect(state.read()).rejects.toThrow();
    }
  });
});
