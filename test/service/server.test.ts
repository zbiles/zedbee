import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as sources from "../../src/inspection/source-capture.js";
import { connect } from "node:net";
import { startServiceServer, IdleLifetime } from "../../src/service/server.js";
import { ServiceState } from "../../src/service/state.js";
import {
  connectService,
  executorForConnection,
} from "../../src/service/client.js";
import { serviceEndpoint } from "../../src/service/transport.js";
import { encodeFrame } from "../../src/service/protocol.js";
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
