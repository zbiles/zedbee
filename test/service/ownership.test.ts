import { expect, it } from "vitest";
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
