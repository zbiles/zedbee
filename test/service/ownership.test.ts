import { expect, it, vi } from "vitest";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ServiceState } from "../../src/service/state.js";
import { startServiceServer } from "../../src/service/server.js";
import {
  connectService,
  executorForConnection,
} from "../../src/service/client.js";
import { createLocalAnalyzerExecutor } from "../../src/checks/runner/executor.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../../src/checks/prettier/settings.js";
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
it("retains the client witness after failed native cleanup and waits for independent proof on connection loss", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zw-")));
  const state = new ServiceState(join(root, "s"));
  await state.prepare();
  const release = (await state.lock())!;
  const server = await startServiceServer(state, "a".repeat(64), 1, release);
  const client = await connectService(state, (await state.read())!);
  const executor = executorForConnection(client);
  let allowProof!: () => void, entered!: () => void;
  const proofGate = new Promise<void>((resolve) => {
    allowProof = resolve;
  });
  const proofEntered = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let independent = false;
  const restores: Array<() => void> = [];
  const independently = async (stop: () => Promise<void>) => {
    independent = true;
    entered();
    await proofGate;
    await stop();
  };
  if (process.platform === "win32") {
    const native = await import("../../src/checks/runner/windows-job.js");
    const fail = vi
      .spyOn(native, "stopWindowsJob")
      .mockRejectedValueOnce(new Error("Injected native cleanup failure"));
    restores.push(() => fail.mockRestore());
    const witnesses = await import("../../src/service/windows-pipe.js");
    const original = witnesses.openWindowsJobWitness;
    const open = vi
      .spyOn(witnesses, "openWindowsJobWitness")
      .mockImplementation((name) => {
        const witness = original(name);
        return { ...witness, stop: () => independently(() => witness.stop()) };
      });
    restores.push(() => open.mockRestore());
  } else {
    const native = await import("../../src/checks/runner/process-group.js");
    const original = native.stopProcessGroup;
    let failed = false;
    const stop = vi
      .spyOn(native, "stopProcessGroup")
      .mockImplementation(async (pid) => {
        if (!failed) {
          failed = true;
          throw new Error("Injected native cleanup failure");
        }
        await independently(() => original(pid));
      });
    restores.push(() => stop.mockRestore());
  }
  try {
    const session = await executor.openSession();
    expect(await session.run(request)).toBe("const a = 1;\n");
    // A real engine error retires the real assigned worker; only its owner's
    // native cleanup boundary is fault-injected, not worker code or ownership.
    await expect(
      session.run({
        ...request,
        input: { ...request.input, source: "const =" },
      }),
    ).rejects.toMatchObject({ diagnostic: { category: "cleanup" } });
    expect(independent).toBe(false);
    let closed = false;
    const closing = client.close().then(() => {
      closed = true;
    });
    await Promise.race([proofEntered, closing]);
    expect(independent).toBe(true);
    expect(closed).toBe(false);
    allowProof();
    await closing;
    expect(closed).toBe(true);
  } finally {
    allowProof();
    await client.close().catch(() => {});
    for (const restore of restores) restore();
    await executor.close().catch(() => {});
    await server.close().catch(() => {});
    await release();
    await rm(root, { recursive: true, force: true });
  }
});
it("waits for authoritative acquisition and release acknowledgements before execution and reuse", async () => {
  let acquire!: () => void, release!: () => void;
  let acquired = false,
    released = false,
    completed = false;
  const witnesses: string[] = [];
  let releases = 0;
  let sawAcquire!: () => void, sawRelease!: () => void;
  const acquiring = new Promise<void>((resolve) => {
    sawAcquire = resolve;
  });
  const releasing = new Promise<void>((resolve) => {
    sawRelease = resolve;
  });
  const executor = createLocalAnalyzerExecutor({
    concurrency: 1,
    ownership: {
      async acquire(_session: unknown, witness: any) {
        witnesses.push(witness.id);
        expect(witness.id).toMatch(/^[a-f0-9]{64}$/);
        expect(witness.kind).toBe(
          process.platform === "win32" ? "windows" : "posix",
        );
        acquired = true;
        sawAcquire();
        if (witnesses.length > 1) return;
        await new Promise<void>((resolve) => {
          acquire = resolve;
        });
      },
      async release() {
        if (++releases > 1) return;
        released = true;
        sawRelease();
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      },
    },
  });
  const session = await executor.openSession();
  const job = session.run(request).then((result) => {
    completed = true;
    return result;
  });
  try {
    await Promise.race([
      acquiring,
      job.then(() => {
        throw new Error("Job completed before ownership acquisition");
      }),
    ]);
    expect(acquired).toBe(true);
    expect(completed).toBe(false);
    acquire();
    expect(await job).toBe("const a = 1;\n");
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await Promise.race([
      releasing,
      closing.then(() => {
        throw new Error("Session closed before ownership release");
      }),
    ]);
    expect(released).toBe(true);
    expect(closed).toBe(false);
    const second = await executor.openSession();
    let nextCompleted = false;
    const next = second.run(request).then((result) => {
      nextCompleted = true;
      return result;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(nextCompleted).toBe(false);
    expect(witnesses).toHaveLength(1);
    release();
    await closing;
    expect(await next).toBe("const a = 1;\n");
    expect(witnesses).toEqual([witnesses[0], witnesses[0]]);
    await second.close();
  } finally {
    acquire?.();
    release?.();
    await executor.close();
  }
});
