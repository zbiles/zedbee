import { expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ServiceState } from "../../src/service/state.js";
import { startServiceServer } from "../../src/service/server.js";
import {
  acquireServiceExecutor,
  connectService,
  executorForConnection,
  stopService,
} from "../../src/service/client.js";
import { serviceIdentity } from "../../src/service/identity.js";
import { ServiceConnection } from "../../src/service/transport.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../src/checks/prettier/settings.js";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

it.each([
  [1, false],
  [2, false],
  [1, true],
] as const)(
  "replaces a stale service after cleanup with %s upgrader(s), initial discovery absent: %s",
  async (count, absent) => {
    const root = await realpath(await mkdtemp(join(tmpdir(), "zu-")));
    const state = new ServiceState(join(root, "s"));
    await state.prepare();
    const release = (await state.lock())!;
    const releasing = gate(),
      allowRelease = gate();
    const old = await startServiceServer(state, "a".repeat(64), 2, async () => {
      releasing.resolve();
      await allowRelease.promise;
      await release();
    });
    const read = absent
      ? vi
          .spyOn(ServiceState.prototype, "read")
          .mockResolvedValueOnce(undefined)
      : undefined;
    const requests = Array.from({ length: count }, () =>
      acquireServiceExecutor({ directory: state.directory }),
    );
    const acquisition = Promise.all(requests);
    let settled = false;
    void acquisition.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    let executors: Awaited<typeof acquisition> = [];
    try {
      // Without stale-service retirement this rejects after the existing readiness
      // deadline: the candidate cannot acquire the still-running old owner's lock.
      await Promise.race([releasing.promise, acquisition]);
      expect(settled).toBe(false);
      expect(await state.read()).toBeUndefined();
      const contender = await state.lock();
      try {
        expect(contender).toBeUndefined();
      } finally {
        await contender?.();
      }
      allowRelease.resolve();
      executors = await acquisition;
      for (const executor of executors) {
        const session = await executor.openSession();
        await session.close();
      }
      const current = (await state.read())!;
      expect(current.instance).not.toBe(old.instance);
      expect(current.identity).not.toBe("a".repeat(64));
    } finally {
      read?.mockRestore();
      allowRelease.resolve();
      await old.close();
      executors = (await Promise.allSettled(requests)).flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      await Promise.all(executors.map((executor) => executor.close()));
      await stopService({ directory: state.directory });
      await release();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it("lets existing sessions finish while rejecting new sessions during upgrade", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zu-")));
  const state = new ServiceState(join(root, "s"));
  await state.prepare();
  const release = (await state.lock())!;
  const old = await startServiceServer(state, "a".repeat(64), 2, release);
  const existing = executorForConnection(
    await connectService(state, (await state.read())!),
  );
  const session = await existing.openSession();
  const drainAccepted = gate();
  const send = ServiceConnection.prototype.send;
  const witness = vi
    .spyOn(ServiceConnection.prototype, "send")
    .mockImplementation(function (this: ServiceConnection, value: unknown) {
      // The drain completion-witness handoff happens after admission closes.
      if (
        value &&
        typeof value === "object" &&
        "type" in value &&
        value.type === "io-acquire"
      )
        drainAccepted.resolve();
      return send.call(this, value);
    });
  const acquisition = acquireServiceExecutor({ directory: state.directory });
  let settled = false;
  void acquisition.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  let current: Awaited<typeof acquisition> | undefined;
  try {
    await Promise.race([drainAccepted.promise, acquisition]);
    await expect(existing.openSession()).rejects.toMatchObject({
      code: "ANALYZER_SERVICE_UNAVAILABLE",
    });
    expect(settled).toBe(false);
    expect((await state.read())!.instance).toBe(old.instance);
    expect(
      await session.run({
        version: 1,
        checkId: "formatting",
        operation: "format-working-source",
        input: {
          file: "a.js",
          source: "const a=1",
          settings: DEFAULT_FORMATTING_SETTINGS,
        },
      }),
    ).toBe("const a = 1;\n");
    await session.close();
    current = await acquisition;
    await (await current.openSession()).close();
    expect((await state.read())!.instance).not.toBe(old.instance);
  } finally {
    witness.mockRestore();
    await existing.close().catch(() => {});
    await old.close();
    current ??= await acquisition.catch(() => undefined);
    await current?.close();
    await stopService({ directory: state.directory });
    await release();
    await rm(root, { recursive: true, force: true });
  }
});

it("fails safely with recovery guidance when an older service rejects drain", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zu-")));
  const state = new ServiceState(join(root, "s"));
  await state.prepare();
  const release = (await state.lock())!;
  const old = await startServiceServer(state, "a".repeat(64), 2, release);
  const existing = executorForConnection(
    await connectService(state, (await state.read())!),
  );
  const session = await existing.openSession();
  const send = ServiceConnection.prototype.send;
  // Exercise the real authenticated server's unknown-operation response, as a
  // pre-drain development version would return. Other protocol traffic is real.
  const legacy = vi
    .spyOn(ServiceConnection.prototype, "send")
    .mockImplementation(function (this: ServiceConnection, value: unknown) {
      if (
        value &&
        typeof value === "object" &&
        "op" in value &&
        value.op === "drain"
      )
        return send.call(this, { ...value, op: "unsupported-drain" });
      return send.call(this, value);
    });
  try {
    await expect(
      acquireServiceExecutor({ directory: state.directory }),
    ).rejects.toMatchObject({
      code: "ANALYZER_SERVICE_UNAVAILABLE",
      message: expect.stringContaining(
        "After active scans finish, run `zedbee service stop`",
      ),
    });
    expect(old.status()).toMatchObject({ state: "running", activeSessions: 1 });
    expect((await state.read())!.instance).toBe(old.instance);
    expect(
      await session.run({
        version: 1,
        checkId: "formatting",
        operation: "format-working-source",
        input: {
          file: "a.js",
          source: "const a=1",
          settings: DEFAULT_FORMATTING_SETTINGS,
        },
      }),
    ).toBe("const a = 1;\n");
    await session.close();
    await (await existing.openSession()).close();
  } finally {
    legacy.mockRestore();
    await existing.close();
    await old.close();
    await release();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps a matching service published after the initial stale discovery", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zu-")));
  const state = new ServiceState(join(root, "s"));
  await state.prepare();
  const identity = await serviceIdentity(state.directory);
  const release = (await state.lock())!;
  const current = await startServiceServer(state, identity.content, 2, release);
  const record = (await state.read())!;
  const read = vi.spyOn(ServiceState.prototype, "read").mockResolvedValueOnce({
    ...record,
    identity: "a".repeat(64),
    instance: "b".repeat(64),
    secret: "c".repeat(64),
  });
  let executor: Awaited<ReturnType<typeof acquireServiceExecutor>> | undefined;
  try {
    executor = await acquireServiceExecutor({ directory: state.directory });
    await (await executor.openSession()).close();
    expect((await state.read())!.instance).toBe(current.instance);
  } finally {
    read.mockRestore();
    await executor?.close();
    await current.close();
    await release();
    await rm(root, { recursive: true, force: true });
  }
});
