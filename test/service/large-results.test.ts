import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceState } from "../../src/service/state.js";
import { startServiceServer } from "../../src/service/server.js";
import {
  connectService,
  executorForConnection,
} from "../../src/service/client.js";
import * as executors from "../../src/checks/runner/executor.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../src/checks/prettier/settings.js";

const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
  cleanups.length = 0;
  vi.restoreAllMocks();
});
async function fixture(result: () => string) {
  // Replace only analyzer computation; retain real authentication, framing,
  // result validation, connection ownership and session cleanup.
  vi.spyOn(executors, "createLocalAnalyzerExecutor").mockReturnValue({
    async openSession() {
      return { run: async () => result() as never, async close() {} };
    },
    async close() {},
  });
  const root = await realpath(await mkdtemp(join(tmpdir(), "zlr-")));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const state = new ServiceState(join(root, "s"));
  await state.prepare();
  const release = await state.lock();
  const server = await startServiceServer(state, "a".repeat(64), 2, release!);
  cleanups.push(() => server.close());
  const client = await connectService(state, (await state.read())!);
  cleanups.push(() => client.close());
  return { client, server, executor: executorForConnection(client) };
}
const request = {
  version: 1,
  checkId: "formatting",
  operation: "format-working-source",
  input: {
    file: "probe.js",
    source: "const n=1",
    settings: DEFAULT_FORMATTING_SETTINGS,
  },
} as const;

describe("large service results", () => {
  it("leaves room for control and error replies when result admission is full", async () => {
    const envelopeBytes = Buffer.byteLength(
      JSON.stringify({ id: 1, ok: true, result: "" }),
    );
    const text = "x".repeat(32 * 1024 * 1024 - envelopeBytes);
    const { client, executor } = await fixture(() => text);
    const session = await executor.openSession();
    const results = await Promise.allSettled([
      session.run(request),
      session.run(request),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(await client.request("status")).toMatchObject({ state: "running" });
    await session.close();
    await executor.close();
  });
  it("returns concurrent results larger than a frame intact, then closes the session", async () => {
    const text = "🦋abc\n".repeat(3 * 1024 * 1024);
    const { client, executor, server } = await fixture(() => text);
    const session = await executor.openSession();
    const results = await Promise.all([
      session.run(request),
      session.run(request),
    ]);
    expect(results).toEqual([text, text]);
    await session.close();
    expect(server.status()).toMatchObject({ activeSessions: 0 });
    expect(await client.request("status")).toMatchObject({ state: "running" });
    await executor.close();
  });

  it("reports an oversized result without disconnecting or preventing later work and cleanup", async () => {
    let text = "x".repeat(129 * 1024 * 1024);
    const { client, executor, server } = await fixture(() => text);
    const session = await executor.openSession();
    await expect(session.run(request)).rejects.toMatchObject({
      code: "ANALYZER_RESULT_CAPACITY_EXCEEDED",
    });
    text = "const n = 1;\n";
    expect(await session.run(request)).toBe("const n = 1;\n");
    expect(await client.request("status")).toMatchObject({ state: "running" });
    await session.close();
    expect(server.status()).toMatchObject({ activeSessions: 0 });
    await executor.close();
  });
  it("transfers a result larger than the entire in-flight frame budget", async () => {
    const text = "x".repeat(70 * 1024 * 1024);
    const { executor } = await fixture(() => text);
    const session = await executor.openSession();
    expect(await session.run(request)).toBe(text);
    await session.close();
    await executor.close();
  });
});
