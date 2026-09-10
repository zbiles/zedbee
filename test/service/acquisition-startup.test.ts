import { afterEach, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ServiceIdentity } from "../../src/service/identity.js";
import { ServiceState } from "../../src/service/state.js";
import { startServiceServer } from "../../src/service/server.js";

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  identity: vi.fn(),
  location: vi.fn(),
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: mocks.spawn,
}));
vi.mock("../../src/service/identity.js", async (original) => ({
  ...(await original<typeof import("../../src/service/identity.js")>()),
  serviceIdentity: mocks.identity,
  serviceLocation: mocks.location,
}));
import { acquireServiceExecutor } from "../../src/service/client.js";

function gate<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
class Candidate extends EventEmitter {
  pid: number | undefined = 12345;
  connected = true;
  sent = gate<Record<string, unknown>>();
  messages: Record<string, unknown>[] = [];
  lostConnection = gate();
  signals: string[] = [];
  send(
    value: Record<string, unknown>,
    callback?: (error: Error | null) => void,
  ) {
    this.messages.push(value);
    this.sent.resolve(value);
    callback?.(null);
    return true;
  }
  disconnect() {
    this.connected = false;
    this.lostConnection.resolve();
  }
  unref() {}
  kill(signal: string) {
    this.signals.push(signal);
    return true;
  }
}
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.spawn.mockReset();
  mocks.identity.mockReset();
  mocks.location.mockReset();
  for (const root of roots.splice(0)) await rm(root, { recursive: true });
});
async function fixture(discoveryPresent = false) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "za-")));
  roots.push(root);
  const identity: ServiceIdentity = {
    key: "a".repeat(64),
    content: "b".repeat(64),
    entry: join(root, "fixed-entry.js"),
    directory: join(root, "s"),
  };
  const pending = gate<ServiceIdentity>(),
    started = gate();
  mocks.location.mockResolvedValue(identity);
  mocks.identity.mockImplementation(() => {
    started.resolve();
    return pending.promise;
  });
  const child = new Candidate();
  mocks.spawn.mockReturnValue(child);
  if (discoveryPresent)
    vi.spyOn(ServiceState.prototype, "read").mockResolvedValueOnce({
      identity: "c".repeat(64),
    } as Awaited<ReturnType<ServiceState["read"]>>);
  const request = acquireServiceExecutor();
  let settled = false;
  void request.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await started.promise;
  return { child, pending, request, identity, settled: () => settled };
}

it("starts the fixed candidate before parent identity finishes, and owns exit after parent rejection", async () => {
  const f = await fixture();
  try {
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    expect(mocks.spawn.mock.calls[0]!.slice(0, 2)).toEqual([
      process.execPath,
      [f.identity.entry],
    ]);
    expect(f.child.messages).toEqual([]);
    const error = new Error("hash failed");
    f.pending.reject(error);
    await f.child.lostConnection.promise;
    expect(f.settled()).toBe(false);
    f.child.emit("exit", 1);
    await expect(f.request).rejects.toBe(error);
  } finally {
    f.pending.reject(new Error("cleanup"));
    f.child.emit("exit", 1);
    await f.request.catch(() => {});
  }
});

it("bounds startup IPC only after the full parent identity finishes and still owns timed-out exit", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = await fixture();
  try {
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(f.child.connected).toBe(true);
    expect(f.child.messages).toEqual([]);
    expect(f.settled()).toBe(false);
    f.pending.resolve(f.identity);
    expect(await f.child.sent.promise).toEqual({
      directory: f.identity.directory,
      identity: f.identity.content,
      concurrency: 2,
    });
    await vi.advanceTimersByTimeAsync(29_999);
    expect(f.child.connected).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.child.connected).toBe(false);
    expect(f.settled()).toBe(false);
    f.child.emit("exit", 0);
    await expect(f.request).rejects.toThrow();
  } finally {
    f.pending.reject(new Error("cleanup"));
    f.child.emit("exit", 1);
    await f.request.catch(() => {});
  }
});

it("leaves discovery-present acquisition lazy and retains the stale-discovery startup fallback", async () => {
  const f = await fixture(true);
  try {
    expect(mocks.spawn).not.toHaveBeenCalled();
    f.pending.resolve(f.identity);
    expect(await f.child.sent.promise).toEqual({
      directory: f.identity.directory,
      identity: f.identity.content,
      concurrency: 2,
    });
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    f.child.emit("exit", 1);
    await expect(f.request).rejects.toThrow();
  } finally {
    f.pending.reject(new Error("cleanup"));
    f.child.emit("exit", 1);
    await f.request.catch(() => {});
  }
});

it.each(["spawn-error", "child-exit", "invalid-response"])(
  "retains parent hash ownership through %s",
  async (scenario) => {
    const f = await fixture();
    try {
      expect(mocks.spawn).toHaveBeenCalledTimes(1);
      if (scenario === "spawn-error") {
        f.child.pid = undefined;
        f.child.emit("error", new Error("spawn failed"));
      } else if (scenario === "child-exit") f.child.emit("exit", 1);
      else {
        f.child.emit("message", { unexpected: true });
        await f.child.lostConnection.promise;
        f.child.emit("exit", 1);
      }
      await Promise.resolve();
      expect(f.settled()).toBe(false);
      f.pending.resolve(f.identity);
      await expect(f.request).rejects.toThrow();
    } finally {
      f.pending.reject(new Error("cleanup"));
      f.child.emit("exit", 1);
      await f.request.catch(() => {});
    }
  },
);

it("owns candidate cleanup when sending startup throws synchronously", async () => {
  const f = await fixture();
  try {
    vi.spyOn(f.child, "send").mockImplementation(() => {
      throw new Error("IPC closed");
    });
    f.pending.resolve(f.identity);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(f.child.connected).toBe(false);
    expect(f.settled()).toBe(false);
    f.child.emit("exit", 1);
    await expect(f.request).rejects.toThrow();
  } finally {
    f.pending.reject(new Error("cleanup"));
    f.child.emit("exit", 1);
    await f.request.catch(() => {});
  }
});

it.each([false, true])(
  "owns a potentially delivered failed detach through exit (throws=%s)",
  async (throws) => {
    const f = await fixture();
    try {
      f.pending.resolve(f.identity);
      await f.child.sent.promise;
      vi.spyOn(f.child, "send").mockImplementation((_value, callback) => {
        if (throws) throw new Error("IPC closed");
        callback?.(new Error("IPC closed"));
        return false;
      });
      expect(() => f.child.emit("message", { type: "ready" })).not.toThrow();
      await f.child.lostConnection.promise;
      expect(f.child.signals).toEqual(["SIGTERM"]);
      expect(f.settled()).toBe(false);
      f.child.emit("exit", 0);
      await expect(f.request).rejects.toThrow();
    } finally {
      f.pending.reject(new Error("cleanup"));
      f.child.emit("exit", 1);
      await f.request.catch(() => {});
    }
  },
);

it("waits for a busy candidate's exit then polls without launching a second candidate", async () => {
  const f = await fixture();
  const state = new ServiceState(f.identity.directory);
  // A busy response means another startup owns this lock. Keep ownership
  // through publication so the client cannot legitimately start a replacement.
  const release = (await state.lock())!;
  let server: Awaited<ReturnType<typeof startServiceServer>> | undefined;
  let executor: Awaited<typeof f.request> | undefined;
  const polled = gate();
  const originalRead = ServiceState.prototype.read;
  try {
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    f.pending.resolve(f.identity);
    expect(await f.child.sent.promise).toEqual({
      directory: f.identity.directory,
      identity: f.identity.content,
      concurrency: 2,
    });
    f.child.emit("message", { type: "busy" });
    await f.child.lostConnection.promise;
    expect(f.settled()).toBe(false);
    vi.spyOn(ServiceState.prototype, "read").mockImplementation(async function (
      this: ServiceState,
    ) {
      const result = await originalRead.call(this);
      if (!result) polled.resolve();
      return result;
    });
    f.child.emit("exit", 0);
    await polled.promise;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
    server = await startServiceServer(state, f.identity.content, 2, release);
    executor = await f.request;
    expect(mocks.spawn).toHaveBeenCalledTimes(1);
  } finally {
    f.pending.reject(new Error("cleanup"));
    f.child.emit("exit", 1);
    await executor?.close();
    await server?.close();
    await release();
    await f.request.catch(() => {});
  }
});
