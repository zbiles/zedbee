import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const entry = fileURLToPath(
  new URL("../../../src/checks/runner/bootstrap.ts", import.meta.url),
);
it("waits for ownership before importing the worker and exits on owner loss", async () => {
  const child = spawn(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), entry],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
    },
  );
  const closed = once(child, "exit");
  try {
    const first = await Promise.race([
      once(child, "message"),
      closed.then(() => ["closed before ownership gate"]),
    ]);
    expect(first[0]).toEqual({ type: "ready-for-ownership" });
    expect(child.exitCode).toBeNull();
    child.disconnect();
    expect(await closed).toEqual([0, null]);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});

it("loads the selected worker only after release and delivers the first request", async () => {
  const child = spawn(
    process.execPath,
    ["--import", import.meta.resolve("tsx"), entry],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
    },
  );
  const closed = once(child, "exit");
  try {
    expect((await Promise.race([once(child, "message"), closed]))[0]).toEqual({
      type: "ready-for-ownership",
    });
    const reply = once(child, "message");
    child.send({
      type: "owned-start",
      workerEntry: fileURLToPath(
        new URL("./fixtures/worker.mjs", import.meta.url),
      ),
      request: { input: { source: '{"mode":"pid"}' } },
    });
    const [result] = await reply;
    expect(JSON.parse(result.result).workerPid).toBe(child.pid);
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
});
