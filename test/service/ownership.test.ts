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
  const executor = createLocalAnalyzerExecutor({
    concurrency: 1,
    ownership: {
      async acquire(_session: unknown, witness: any) {
        expect(witness.id).toMatch(/^[a-f0-9]{64}$/);
        expect(witness.kind).toBe(
          process.platform === "win32" ? "windows" : "posix",
        );
        acquired = true;
        await new Promise<void>((resolve) => {
          acquire = resolve;
        });
      },
      async release() {
        released = true;
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
    await expect.poll(() => acquired).toBe(true);
    expect(completed).toBe(false);
    acquire();
    expect(await job).toBe("const a = 1;\n");
    let closed = false;
    const closing = session.close().then(() => {
      closed = true;
    });
    await expect.poll(() => released).toBe(true);
    expect(closed).toBe(false);
    release();
    await closing;
  } finally {
    acquire?.();
    release?.();
    await executor.close();
  }
});
