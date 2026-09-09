import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { DEFAULT_FORMATTING_SETTINGS } from "../../../src/checks/prettier/settings.js";

const entry = fileURLToPath(
  new URL("../../../src/checks/runner/bootstrap.ts", import.meta.url),
);
it("the real worker acknowledges a flushed result and explicit session release", async () => {
  const child = spawn(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      fileURLToPath(
        new URL("../../../src/checks/runner/worker.ts", import.meta.url),
      ),
    ],
    {
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      serialization: "advanced",
    },
  );
  const exited = once(child, "exit");
  try {
    const reply = once(child, "message");
    const messages: any[] = [];
    child.on("message", (value) => messages.push(value));
    child.send({
      version: 1,
      type: "job",
      sessionId: "session",
      jobId: "job",
      request: {
        version: 1,
        checkId: "formatting",
        operation: "format-working-source",
        input: {
          file: "a.js",
          source: "const x=1",
          settings: DEFAULT_FORMATTING_SETTINGS,
        },
      },
    });
    expect((await reply)[0]).toMatchObject({
      type: "result",
      sessionId: "session",
      jobId: "job",
      response: { ok: true, result: "const x = 1;\n" },
    });
    await expect
      .poll(() => messages.some((value) => value.type === "ready"))
      .toBe(true);
    expect(child.exitCode).toBeNull();
    const released = once(child, "message");
    child.send({ version: 1, type: "release", sessionId: "session" });
    expect((await released)[0]).toEqual({
      version: 1,
      type: "released",
      sessionId: "session",
      retire: false,
    });
    expect(child.exitCode).toBeNull();
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
    await exited;
  }
});
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
      request: {
        version: 1,
        type: "job",
        sessionId: "session",
        jobId: "job",
        request: { input: { source: '{"mode":"pid"}' } },
      },
    });
    const [result] = await reply;
    expect(JSON.parse(result.response.result).workerPid).toBe(child.pid);
  } finally {
    child.kill("SIGKILL");
    await closed;
  }
});
