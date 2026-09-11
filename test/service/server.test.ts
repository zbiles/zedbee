import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as sources from "../../src/inspection/source-capture.js";
import { connect, createServer, type Socket } from "node:net";
import { startServiceServer, IdleLifetime } from "../../src/service/server.js";
import { ServiceState } from "../../src/service/state.js";
import {
  connectService,
  executorForConnection,
} from "../../src/service/client.js";
import { serviceEndpoint } from "../../src/service/transport.js";
import { encodeFrame } from "../../src/service/protocol.js";
import { ByteBudget, FrameDecoder } from "../../src/service/protocol.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../src/checks/prettier/settings.js";
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
});
async function fixture() {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "zs-")));
  cleanups.push(() => rm(parent, { recursive: true, force: true }));
  const state = new ServiceState(join(parent, "s"));
  await state.prepare();
  const release = await state.lock();
  const server = await startServiceServer(
    state,
    "a".repeat(64),
    2,
    release!,
  ).catch(async (error) => {
    await release?.();
    throw error;
  });
  cleanups.push(() => server.close());
  const record = (await state.read())!;
  return { state, server, record };
}
const request = {
  version: 1,
  checkId: "formatting",
  operation: "format-working-source",
  input: {
    file: "a.js",
    source: "const a=1",
    settings: DEFAULT_FORMATTING_SETTINGS,
  },
} as const;
describe("service executor isolation", () => {
  it("returns operation admission capacity without disconnecting other accepted requests", async () => {
    const { state, record } = await fixture();
    const client = await connectService(state, record);
    cleanups.push(() => client.close());
    const outcomes = await Promise.all(
      Array.from({ length: 32 }, () =>
        client.request("status").catch((error) => error),
      ),
    );
    for (const result of outcomes) {
      if (result instanceof Error)
        expect(result).toMatchObject({
          code: "ANALYZER_CAPACITY",
          scope: "job",
        });
      else expect(result).toMatchObject({ state: "running" });
    }
    expect(await client.request("status")).toMatchObject({ state: "running" });
  });
  it("rejects a locally oversized encoded request before acceptance and keeps the connection usable", async () => {
    const { state, record } = await fixture();
    const executor = executorForConnection(await connectService(state, record));
    cleanups.push(() => executor.close());
    const session = await executor.openSession();
    await expect(
      session.run({
        ...request,
        input: { ...request.input, source: "\0".repeat(3 * 1024 * 1024) },
      }),
    ).rejects.toMatchObject({ code: "ANALYZER_CAPACITY", scope: "request" });
    expect(await session.run(request)).toBe("const a = 1;\n");
    await session.close();
  });
  it("retires a disconnected client's witnessed tree without stopping another client's worker", async () => {
    const { state, record, server } = await fixture();
    const firstClient = await connectService(state, record);
    cleanups.push(() => firstClient.close());
    const secondClient = await connectService(state, record);
    const first = executorForConnection(firstClient),
      second = executorForConnection(secondClient);
    cleanups.push(() => second.close());
    const a = await first.openSession(),
      b = await second.openSession();
    expect(await a.run(request)).toBe("const a = 1;\n");
    expect(await b.run(request)).toBe("const a = 1;\n");
    await firstClient.close();
    // Independent cleanup witnesses have settled. A lost socket must not make
    // the caller retain a snapshot that no analyzer can still read.
    await expect(a.close()).resolves.toBeUndefined();
    await expect(first.close()).resolves.toBeUndefined();
    await expect
      .poll(() => server.status())
      .toMatchObject({ state: "running", activeSessions: 1 });
    expect(await b.run(request)).toBe("const a = 1;\n");
    await b.close();
  });
  it("bounds global sessions across clients and returns structured capacity without starting workers", async () => {
    const { state, record, server } = await fixture();
    const clients = await Promise.all(
      Array.from({ length: 9 }, () => connectService(state, record)),
    );
    const executors = clients.map(executorForConnection);
    for (const executor of executors) cleanups.push(() => executor.close());
    for (const executor of executors.slice(0, 8))
      for (let count = 0; count < 4; count++) await executor.openSession();
    expect(server.status()).toMatchObject({ activeSessions: 32 });
    await expect(executors[8]!.openSession()).rejects.toMatchObject({
      code: "ANALYZER_CAPACITY",
      scope: "session",
    });
    await executors[0]!.close();
    await (await executors[8]!.openSession()).close();
  });
  it("never sends source to a hijacked endpoint whose server proof is wrong", async () => {
    const parent = await realpath(await mkdtemp(join(tmpdir(), "zh-")));
    cleanups.push(() => rm(parent, { recursive: true, force: true }));
    const state = new ServiceState(join(parent, "s"));
    await state.prepare();
    const record = {
      version: 1,
      identity: "a".repeat(64),
      instance: "b".repeat(64),
      secret: "c".repeat(64),
    } as const;
    const seen: unknown[] = [],
      sockets = new Set<Socket>();
    const fake = createServer((socket) => {
      sockets.add(socket);
      socket.on("error", () => {});
      socket.once("close", () => sockets.delete(socket));
      const decoder = new FrameDecoder(
        new ByteBudget(65536),
        65536,
        (value, release) => {
          seen.push(value);
          release();
          const type = (value as any).type;
          socket.write(
            encodeFrame(
              type === "hello"
                ? {
                    type: "challenge",
                    nonce: "d".repeat(64),
                    proof: "e".repeat(64),
                  }
                : { type: "authenticated" },
            ),
          );
        },
      );
      socket.on("data", (chunk) => {
        try {
          decoder.push(chunk as Buffer);
        } catch {
          socket.destroy();
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      fake.once("error", reject);
      fake.listen(serviceEndpoint(state, record.instance), resolve);
    });
    cleanups.push(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => fake.close(() => resolve()));
    });
    await expect(
      connectService(state, record).then(async (client) => {
        try {
          const executor = executorForConnection(client);
          return await (await executor.openSession()).run(request);
        } finally {
          await client.close();
        }
      }),
    ).rejects.toThrow();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ type: "hello" });
    expect(JSON.stringify(seen)).not.toContain("const a=1");
  });
  it("expires only after five minutes with zero active sessions; status does not reset it", () => {
    let now = 0;
    const idle = new IdleLifetime(() => now);
    now = 299999;
    expect(idle.expired).toBe(false);
    idle.open();
    now = 600000;
    expect(idle.expired).toBe(false);
    idle.close();
    now = 899999;
    expect(idle.expired).toBe(false);
    now = 900000;
    expect(idle.expired).toBe(true);
  });
  it("executes through the real analyzer and releases only the caller's sessions", async () => {
    const { state, record } = await fixture();
    const first = await connectService(state, record),
      second = await connectService(state, record);
    const a = executorForConnection(first),
      b = executorForConnection(second);
    cleanups.push(
      () => a.close(),
      () => b.close(),
    );
    const sa = await a.openSession(),
      sb = await b.openSession();
    expect(await sa.run(request)).toBe("const a = 1;\n");
    expect(await first.request("status")).toMatchObject({
      state: "running",
      activeSessions: 2,
      concurrency: 2,
    });
    await a.close();
    expect(await sb.run(request)).toBe("const a = 1;\n");
    expect(await second.request("status")).toMatchObject({ activeSessions: 1 });
    await sb.close();
  });
  it("rejects wrong secrets and identities before a session can be opened", async () => {
    const { state, record, server } = await fixture();
    await expect(
      connectService(state, { ...record, secret: "f".repeat(64) }),
    ).rejects.toThrow();
    await expect(
      connectService(state, { ...record, identity: "f".repeat(64) }),
    ).rejects.toThrow();
    expect(server.status()).toMatchObject({ activeSessions: 0 });
  });
  it("does not accept unauthenticated operations or malformed and oversized frames", async () => {
    const { state, record, server } = await fixture();
    for (const input of [
      encodeFrame({ op: "open", id: 1, options: {} }),
      Buffer.from([255, 255, 255, 255]),
    ]) {
      await new Promise<void>((resolve, reject) => {
        const socket = connect(serviceEndpoint(state, record.instance));
        socket.once("connect", () => socket.write(input));
        socket.on("error", () => {});
        socket.once("close", () => resolve());
        socket.once("data", () =>
          reject(new Error("Unauthenticated operation produced data")),
        );
      });
    }
    expect(server.status()).toMatchObject({ activeSessions: 0 });
  });
  it("rejects forged captures, wire worker entries and another client's session IDs", async () => {
    const { state, record } = await fixture();
    const first = await connectService(state, record),
      second = await connectService(state, record);
    cleanups.push(
      () => first.close(),
      () => second.close(),
    );
    const result = (await first.request("open", { options: {} })) as {
      sessionId: string;
    };
    await expect(
      second.request("run", { sessionId: result.sessionId, request }),
    ).rejects.toThrow();
    await expect(
      first.request("open", { options: { capture: {} } }),
    ).rejects.toThrow();
    await expect(
      first.request("run", {
        sessionId: result.sessionId,
        request,
        workerEntry: "/arbitrary",
      }),
    ).rejects.toThrow();
  });
  it("keeps client close pending during disconnected source acquisition with no worker assigned", async () => {
    const { state, record } = await fixture();
    const source = join(dirname(state.directory), "source");
    await mkdir(source);
    await writeFile(join(source, "a.js"), "const a=1");
    const client = await connectService(state, record),
      executor = executorForConnection(client);
    let unblock!: () => void,
      started = false,
      closed = false;
    const actual = sources.captureAnalysisSources;
    const spy = vi
      .spyOn(sources, "captureAnalysisSources")
      .mockImplementation(async (selections) => {
        started = true;
        await new Promise<void>((resolve) => {
          unblock = resolve;
        });
        return actual(selections);
      });
    const opening = executor
      .openSession({
        sourceSelections: [{ snapshotRoot: source, paths: ["a.js"] }],
      })
      .catch((error) => error);
    try {
      await expect.poll(() => started).toBe(true);
      const closing = client.close().then(() => {
        closed = true;
      });
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      expect(closed).toBe(false);
      unblock();
      await closing;
      expect(await opening).toBeInstanceOf(Error);
    } finally {
      unblock?.();
      spy.mockRestore();
      await client.close();
    }
  });
});
