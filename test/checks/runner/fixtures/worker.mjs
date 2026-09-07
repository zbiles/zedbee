import { spawn } from "node:child_process";
import { writeFileSync, existsSync } from "node:fs";
const replyAndExit = (reply) => process.send(reply, () => process.exit(0));

process.on("message", (request) => {
  if (request?.type === "cancel") return;
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
    replyAndExit({ version: 1, ok: true, result });
    return;
  }
  const input = JSON.parse(request.input.source);
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
    process.send({ version: 1, ok: true, result: "not a successful job" }, () =>
      process.exit(input.mode === "reply-then-exit-one" ? 1 : 7),
    );
    return;
  }
  if (input.mode === "reply-then-signal") {
    process.send({ version: 1, ok: true, result: "not a successful job" }, () =>
      process.kill(process.pid, "SIGTERM"),
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
