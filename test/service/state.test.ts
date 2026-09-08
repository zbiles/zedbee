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
