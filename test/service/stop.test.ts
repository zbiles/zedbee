import { expect, it, vi } from "vitest";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServiceState } from "../../src/service/state.js";
import { startServiceServer } from "../../src/service/server.js";
import {
  connectService,
  executorForConnection,
  stopService,
} from "../../src/service/client.js";
import { connect, Server } from "node:net";
import { serviceEndpoint } from "../../src/service/transport.js";

it("drains disconnected clients' state cleanup before releasing stop ownership", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zx-")));
  const state = new ServiceState(join(root, "s"));
  await state.prepare();
  const release = (await state.lock())!;
  let resume!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let removed = false,
    releasedEarly = false;
  const actualRemove = state.removeLease.bind(state);
  const remove = vi
    .spyOn(state, "removeLease")
    .mockImplementation(async (id) => {
      await gate;
      await actualRemove(id);
      removed = true;
    });
  const server = await startServiceServer(
    state,
    "a".repeat(64),
    1,
    async () => {
      releasedEarly = !removed;
      await release();
    },
  );
  const client = executorForConnection(
    await connectService(state, (await state.read())!),
  );
  await client.openSession();
  const originalClose = Server.prototype.close;
  const closing = vi
    .spyOn(Server.prototype, "close")
    .mockImplementation(function (
      this: Server,
      callback?: (error?: Error) => void,
    ) {
      return originalClose.call(this, (error) => {
        callback?.(error);
        // The native listener-close promise resumes first. Only then allow the
        // still-pending client cleanup, deterministically exposing a missing drain.
        queueMicrotask(resume);
      });
    });
  try {
    expect(await stopService({ directory: state.directory })).toEqual({
      state: "stopped",
    });
    expect(releasedEarly).toBe(false);
  } finally {
    resume();
    await client.close().catch(() => {});
    await server.close();
    closing.mockRestore();
    remove.mockRestore();
    await release();
    await rm(root, { recursive: true, force: true });
  }
});

it("does not report successful stop when client completion-file cleanup fails", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zx-")));
  const state = new ServiceState(join(root, "s"));
  await state.prepare();
  const release = (await state.lock())!;
  const server = await startServiceServer(state, "a".repeat(64), 1, release);
  const denied = Object.assign(new Error("Completion deletion denied"), {
    code: "EACCES",
  });
  const remove = vi
    .spyOn(ServiceState.prototype, "removeLease")
    .mockRejectedValue(denied);
  try {
    await expect(stopService({ directory: state.directory })).rejects.toBe(
      denied,
    );
    await server.close();
    const remaining = (await readdir(state.directory)).filter((name) =>
      name.startsWith("io-"),
    );
    expect(remaining).toHaveLength(1);
    expect((await lstat(join(state.directory, remaining[0]!))).size).toBe(0);
    const contender = await state.lock();
    expect(contender).toBeDefined();
    await contender!();
  } finally {
    remove.mockRestore();
    await server.close();
    await release();
    await rm(root, { recursive: true, force: true });
  }
});

it.each([false, true])(
  "does not resolve public stop before endpoint/startup cleanup (release rejects: %s)",
  async (rejectRelease) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "zx-")));
    const state = new ServiceState(join(root, "s"));
    await state.prepare();
    const release = (await state.lock())!;
    let entered!: () => void, resume!: () => void;
    const releasing = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let completion: Awaited<ReturnType<ServiceState["lease"]>> | undefined;
    let completionId: string | undefined,
      completionReleased = false,
      lateRemoval = false;
    const actualRemove = state.removeLease.bind(state);
    const removeSpy = vi
      .spyOn(state, "removeLease")
      .mockImplementation(async (id) => {
        if (completionReleased) lateRemoval = true;
        await actualRemove(id);
      });
    const actualLease = state.lease.bind(state);
    const capture = vi
      .spyOn(state, "lease")
      .mockImplementation(async (...args) => {
        const value = await actualLease(...args);
        if (args[0] === undefined) return value;
        completionId = args[0];
        completion = {
          ...value,
          async close() {
            await value.close();
            completionReleased = true;
          },
        };
        return completion;
      });
    const server = await startServiceServer(
      state,
      "a".repeat(64),
      1,
      async () => {
        entered();
        await gate;
        if (rejectRelease) throw new Error("Startup ownership release failed");
        await release();
      },
    );
    let blocked!: () => void;
    const waiting = new Promise<void>((resolve) => {
      blocked = resolve;
    });
    const original = ServiceState.prototype.lease;
    const leaseSpy = vi
      .spyOn(ServiceState.prototype, "lease")
      .mockImplementation(async function (this: ServiceState, ...args) {
        const lease = await original.apply(this, args);
        return {
          ...lease,
          acquire() {
            const acquired = lease.acquire();
            if (!acquired) blocked();
            return acquired;
          },
        };
      });
    let settled = false;
    const stopping = stopService({ directory: state.directory }).then(
      (value) => {
        settled = true;
        return value;
      },
    );
    try {
      await releasing;
      await Promise.race([waiting, stopping]);
      expect(settled).toBe(false);
      expect(await state.lock()).toBeUndefined();
      // The discovery record has already been cleared, but shutdown still owns
      // the kernel lock. A second caller must not mistake absence for completion.
      expect(await stopService({ directory: state.directory })).toEqual({
        state: "unavailable",
      });
      await expect(
        new Promise<void>((resolve, reject) => {
          const socket = connect(serviceEndpoint(state, server.instance));
          socket.once("error", reject);
          socket.once("connect", () => {
            socket.destroy();
            resolve();
          });
        }),
      ).rejects.toThrow();
      resume();
      if (rejectRelease) {
        await expect(server.close()).rejects.toThrow(
          "Startup ownership release failed",
        );
        expect(settled).toBe(false);
        expect(await state.lock()).toBeUndefined();
        // Fixture-only release of the exact retained native handles simulates
        // OS death for teardown; product failure must not close either handle.
        await release();
        await completion!.close();
      }
      expect(await stopping).toEqual({ state: "stopped" });
      await server.close().catch(() => {});
      expect(lateRemoval).toBe(false);
      await expect(
        lstat(join(state.directory, `io-${completionId}.lock`)),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const contender = await state.lock();
      expect(contender).toBeDefined();
      await contender!();
    } finally {
      resume();
      await release();
      await completion?.close();
      await stopping;
      await server.close().catch(() => {});
      leaseSpy.mockRestore();
      capture.mockRestore();
      removeSpy.mockRestore();
      await rm(root, { recursive: true, force: true });
    }
  },
);
