import { expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServiceState } from "../../src/service/state.js";

function gate<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it.each(["match", "mismatch", "disconnect-before-message"])(
  "owns the eager identity before startup and gates endpoints: %s",
  async (scenario) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "zi-")));
    const state = new ServiceState(join(root, "s"));
    const identity = gate<{ content: string }>(),
      locked = gate(),
      replied = gate<string>();
    let started = 0;
    let server:
      | Awaited<
          ReturnType<
            typeof import("../../src/service/server.js").startServiceServer
          >
        >
      | undefined;
    let contender: (() => Promise<void>) | undefined;
    const handlers = new Map<string, (...args: any[]) => void>();
    const connected = Object.getOwnPropertyDescriptor(process, "connected");
    const exitCode = process.exitCode,
      originalOn = process.on,
      originalSend = process.send!;
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
    const send = vi.spyOn(process, "send").mockImplementation(((
      value: any,
      ...args: any[]
    ) => {
      if (["ready", "busy", "unavailable"].includes(value?.type)) {
        replied.resolve(value.type);
        return true;
      }
      return Reflect.apply(originalSend, process, [value, ...args]);
    }) as NonNullable<typeof process.send>);
    Object.defineProperty(process, "connected", {
      configurable: true,
      value: true,
    });
    vi.doMock("../../src/service/identity.js", () => ({
      serviceIdentity: () => {
        started++;
        return identity.promise;
      },
    }));
    vi.doMock("../../src/service/state.js", async () => {
      const actual = await vi.importActual<
        typeof import("../../src/service/state.js")
      >("../../src/service/state.js");
      return {
        ...actual,
        ServiceState: class extends actual.ServiceState {
          override async lock() {
            const release = await super.lock();
            locked.resolve();
            return release;
          }
        },
      };
    });
    vi.doMock("../../src/service/server.js", async () => {
      const actual = await vi.importActual<
        typeof import("../../src/service/server.js")
      >("../../src/service/server.js");
      return {
        ...actual,
        startServiceServer: async (
          ...args: Parameters<typeof actual.startServiceServer>
        ) => (server = await actual.startServiceServer(...args)),
      };
    });
    try {
      vi.resetModules();
      await import("../../src/service/entry.js");
      expect(started).toBe(1);
      if (scenario === "disconnect-before-message") {
        handlers.get("disconnect")!();
        identity.reject(new Error("metadata read failed after caller loss"));
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(server).toBeUndefined();
        expect(await state.read()).toBeUndefined();
      } else {
        handlers.get("message")!({
          directory: state.directory,
          identity: "a".repeat(64),
          concurrency: 2,
        });
        await locked.promise;
        contender = await state.lock();
        expect(contender).toBeUndefined();
        expect(await state.read()).toBeUndefined();
        identity.resolve({
          content: (scenario === "match" ? "a" : "b").repeat(64),
        });
        expect(await replied.promise).toBe(
          scenario === "match" ? "ready" : "unavailable",
        );
        if (scenario === "match") {
          expect((await state.read())?.identity).toBe("a".repeat(64));
          handlers.get("disconnect")!();
          await server!.close();
        } else expect(await state.read()).toBeUndefined();
        contender = await state.lock();
        expect(contender).toBeDefined();
      }
    } finally {
      identity.resolve({ content: "a".repeat(64) });
      handlers.get("disconnect")?.();
      await server?.close();
      await contender?.();
      on.mockRestore();
      send.mockRestore();
      if (connected) Object.defineProperty(process, "connected", connected);
      else Reflect.deleteProperty(process, "connected");
      process.exitCode = exitCode;
      vi.doUnmock("../../src/service/identity.js");
      vi.doUnmock("../../src/service/state.js");
      vi.doUnmock("../../src/service/server.js");
      vi.resetModules();
      await rm(root, { recursive: true });
    }
  },
);
