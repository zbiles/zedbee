import { mkdtemp, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
  createDefaultDiagnosticProbe,
  runDiagnostics,
} from "../../src/doctor/diagnostics.js";
import type { AnalyzerExecutor } from "../../src/checks/runner/executor.js";
import {
  acquireServiceExecutor,
  serviceStatus,
  stopService,
} from "../../src/service/client.js";
import { removeServiceFixture } from "../service/fixture-cleanup.js";

const context = { cwd: "/not-a-repository", environment: {} };

it("doctor runs a real service analyzer probe without repository snapshots and releases its session", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "zds-")));
  const options = { directory: join(root, "s") };
  const probe = createDefaultDiagnosticProbe({
    acquireServiceExecutor: () => acquireServiceExecutor(options),
  });
  try {
    expect(await serviceStatus(options)).toEqual({ state: "stopped" });
    const diagnostics = await runDiagnostics(
      (id, current) =>
        id === "background-service"
          ? probe(id, current)
          : Promise.resolve({ id, status: "pass", message: "Skipped." }),
      context,
    );
    expect(
      diagnostics.find(({ id }) => id === "background-service"),
    ).toMatchObject({ status: "pass" });
    const first = await serviceStatus(options);
    expect(first).toMatchObject({ state: "running", activeSessions: 0 });
    expect(await probe("background-service", context)).toMatchObject({
      status: "pass",
    });
    expect(await serviceStatus(options)).toEqual(first);
  } finally {
    await removeServiceFixture(root, await stopService(options));
  }
});

it.each([
  "acquire",
  "open",
  "run",
  "result",
  "session-close",
  "executor-close",
])(
  "reports a safe actionable failure after %s failure and closes acquired resources",
  async (stage) => {
    let executorOpen = false;
    let sessionOpen = false;
    const privateError = new Error("token=private /private/customer/source.js");
    const executor: AnalyzerExecutor = {
      async openSession() {
        if (stage === "open") throw privateError;
        sessionOpen = true;
        return {
          async run() {
            if (stage === "run") throw privateError;
            return (
              stage === "result" ? "unexpected" : "const zedbeeDoctor = true;\n"
            ) as never;
          },
          async close() {
            sessionOpen = false;
            if (stage === "session-close") throw privateError;
          },
        };
      },
      async close() {
        executorOpen = false;
        if (stage === "executor-close") throw privateError;
      },
    };
    const probe = createDefaultDiagnosticProbe({
      async acquireServiceExecutor() {
        if (stage === "acquire") throw privateError;
        executorOpen = true;
        return executor;
      },
    });

    const diagnostic = await probe("background-service", context);

    expect(diagnostic).toMatchObject({
      id: "background-service",
      status: "fail",
      remediation: expect.stringContaining("--no-service"),
    });
    expect(JSON.stringify(diagnostic)).not.toContain("private");
    expect(executorOpen).toBe(false);
    expect(sessionOpen).toBe(false);
  },
);
