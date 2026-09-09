import { expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceState } from "../../src/service/state.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

it.each(["disconnect", "SIGTERM", "rejected-setup"])(
  "retains startup ownership through pending endpoint cleanup on %s",
  async (interruption) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "zt-")));
    const state = new ServiceState(join(root, "s"));
    const setup = gate(),
      allowSetup = gate(),
      cleanup = gate(),
      allowCleanup = gate();
    const rejected = gate();
    let actual:
      | Awaited<
          ReturnType<
            typeof import("../../src/service/server.js").startServiceServer
          >
        >
      | undefined;
    let contender: (() => Promise<void>) | undefined;
    const handlers = new Map<string, (...args: any[]) => void>();
    const connected = Object.getOwnPropertyDescriptor(process, "connected");
    const exitCode = process.exitCode;
    const originalOn = process.on;
    const originalSend = process.send!;
    const send = vi.spyOn(process, "send").mockImplementation(((
      message: any,
      ...args: any[]
    ) => {
      // Entry control traffic must not disconnect the test runner's own IPC.
      if (["ready", "busy", "unavailable"].includes(message?.type)) return true;
      return Reflect.apply(originalSend, process, [message, ...args]);
    }) as NonNullable<typeof process.send>);
    const on = vi.spyOn(process, "on").mockImplementation(((
      event: string,
      listener: (...args: any[]) => void,
    ) => {
      if (
        ["message", "disconnect", "SIGTERM", "SIGINT", "SIGHUP"].includes(event)
      ) {
        handlers.set(event, listener);
        return process;
      }
      return originalOn.call(process, event, listener);
    }) as typeof process.on);
    Object.defineProperty(process, "connected", {
      configurable: true,
      value: true,
    });
    vi.doMock("../../src/service/identity.js", () => ({
      serviceIdentity: async () => ({ content: "a".repeat(64) }),
    }));
    vi.doMock("../../src/service/server.js", async () => {
      const original = await vi.importActual<
        typeof import("../../src/service/server.js")
      >("../../src/service/server.js");
      return {
        ...original,
        startServiceServer: async (
          ...args: Parameters<typeof original.startServiceServer>
        ) => {
          actual = await original.startServiceServer(...args);
          setup.resolve();
          await allowSetup.promise;
          if (interruption === "rejected-setup") {
            rejected.resolve();
            throw new Error(
              "Endpoint construction could not return a cleanup owner",
            );
          }
          return {
            ...actual,
            close: async () => {
              cleanup.resolve();
              await allowCleanup.promise;
              await actual!.close();
            },
          };
        },
      };
    });
    try {
      vi.resetModules();
      await import("../../src/service/entry.js");
      handlers.get("message")!({
        directory: state.directory,
        identity: "a".repeat(64),
        concurrency: 1,
      });
      await setup.promise;
      handlers.get(
        interruption === "rejected-setup" ? "disconnect" : interruption,
      )!();
      contender = await state.lock();
      expect(contender).toBeUndefined();
      allowSetup.resolve();
      await (interruption === "rejected-setup"
        ? rejected.promise
        : cleanup.promise);
      contender = await state.lock();
      expect(contender).toBeUndefined();
      allowCleanup.resolve();
      await actual!.close();
      contender = await state.lock();
      expect(contender).toBeDefined();
    } finally {
      allowSetup.resolve();
      allowCleanup.resolve();
      await actual?.close();
      await contender?.();
      on.mockRestore();
      send.mockRestore();
      if (connected) Object.defineProperty(process, "connected", connected);
      else Reflect.deleteProperty(process, "connected");
      process.exitCode = exitCode;
      vi.doUnmock("../../src/service/identity.js");
      vi.doUnmock("../../src/service/server.js");
      vi.resetModules();
      await rm(root, { recursive: true, force: true });
    }
  },
);
