import { spawn } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
let identity;
let failReset = false;
const envelope = (type, extra = {}) => ({
  version: 1,
  ...identity,
  type,
  ...extra,
});
const replyAndExit = (reply) =>
  process.send(envelope("result", { response: reply }), () =>
    process.send(envelope("ready")),
  );

process.on("message", (message) => {
  if (message?.type === "cancel") return;
  if (message?.type === "release") {
    if (failReset) process.exit(1);
    process.send({
      version: 1,
      type: "released",
      sessionId: message.sessionId,
      retire: false,
    });
    return;
  }
  identity = { sessionId: message.sessionId, jobId: message.jobId };
  const request = message.request;
  if (request?.context) {
    const observation = {
      check: request.checkId,
      rule: "runner-fixture",
      identity: String(process.pid),
      severity: "info",
      message: "Runner fixture",
    };
    const result =
      request.operation === "collect"
        ? {
            checkId: request.checkId,
            target: request.context.target,
            baselineObservations: [],
            targetObservations: [observation],
          }
        : request.operation === "planFixes"
          ? []
          : {
              checkId: request.checkId,
              status: "completed",
              durationMs: 0,
              findings: [
                {
                  id: String(process.pid),
                  check: request.checkId,
                  rule: "runner-fixture",
                  severity: "info",
                  message: "Runner fixture",
                  attribution: { kind: "none", staged: false, evidence: [] },
                },
              ],
            };
    if (request.context.repositoryRoot.startsWith("{")) {
      const gate = JSON.parse(request.context.repositoryRoot);
      writeFileSync(gate.path, String(process.pid));
      const poll = setInterval(() => {
        if (!existsSync(gate.release)) return;
        clearInterval(poll);
        replyAndExit({ version: 1, ok: true, result });
      }, 10);
    } else replyAndExit({ version: 1, ok: true, result });
    return;
  }
  const input = JSON.parse(request.input.source);
  if (input.mode === "reset-failure") failReset = true;
  if (input.mode === "surviving-descendant") {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready')",
      ],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        detached: process.platform === "win32",
      },
    );
    child.once("message", () =>
      replyAndExit({
        version: 1,
        ok: true,
        result: JSON.stringify({ workerPid: process.pid, childPid: child.pid }),
      }),
    );
    return;
  }
  if (input.mode === "ready-before-result") {
    process.send(envelope("ready"));
    return;
  }
  if (["duplicate", "stale", "unknown-field"].includes(input.mode)) {
    const result = envelope("result", {
      response: { version: 1, ok: true, result: "inert" },
    });
    if (input.mode === "stale") result.jobId = "stale";
    if (input.mode === "unknown-field") result.secret = "fixture-secret-marker";
    process.send(result, () => {
      if (input.mode === "duplicate") process.send(result);
    });
    return;
  }
  if (input.mode === "idle-crash") {
    replyAndExit({
      version: 1,
      ok: true,
      result: JSON.stringify({
        workerPid: process.pid,
        supervisorPid: process.ppid,
      }),
    });
    setTimeout(() => process.exit(7), 150);
    return;
  }
  if (input.mode === "missing") process.exit(0);
  if (input.mode === "invalid") {
    replyAndExit({
      version: 1,
      ok: true,
      result: { secret: "fixture-secret-marker" },
    });
    return;
  }
  if (input.mode === "crash") {
    process.stderr.write("fixture-secret-marker");
    process.exit(7);
  }
  if (
    input.mode === "reply-then-crash" ||
    input.mode === "reply-then-exit-one"
  ) {
    process.on("SIGTERM", () => {});
    process.send(
      envelope("result", {
        response: { version: 1, ok: true, result: "not a successful job" },
      }),
      () => process.exit(input.mode === "reply-then-exit-one" ? 1 : 7),
    );
    return;
  }
  if (input.mode === "reply-then-signal") {
    process.send(
      envelope("result", {
        response: { version: 1, ok: true, result: "not a successful job" },
      }),
      () => process.kill(process.pid, "SIGTERM"),
    );
    return;
  }
  if (input.mode === "crash-descendant") {
    const child = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"],
      { stdio: "ignore" },
    );
    writeFileSync(
      input.path,
      JSON.stringify({
        workerPid: process.pid,
        childPid: child.pid,
        supervisorPid: process.ppid,
      }),
    );
    process.exit(7);
  }
  if (input.mode === "gate") {
    writeFileSync(input.path, String(process.pid));
    const poll = setInterval(() => {
      if (!existsSync(input.release)) return;
      clearInterval(poll);
      replyAndExit({ version: 1, ok: true, result: String(process.pid) });
    }, 10);
    return;
  }
  if (input.mode === "blocked" || input.mode === "blocked-detached") {
    const child = spawn(
      process.execPath,
      [
        "-e",
        "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); process.send('ready')",
      ],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        detached: input.mode === "blocked-detached",
      },
    );
    child.once("message", () => {
      writeFileSync(
        input.path,
        JSON.stringify({
          workerPid: process.pid,
          childPid: child.pid,
          supervisorPid: process.ppid,
        }),
      );
      while (true) {}
    });
    return;
  }
  replyAndExit({
    version: 1,
    ok: true,
    result: JSON.stringify({ workerPid: process.pid }),
  });
});
