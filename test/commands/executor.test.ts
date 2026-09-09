import { afterEach, expect, it, vi } from "vitest";
import { createCommandExecutor } from "../../src/commands/executor.js";
import { createLocalAnalyzerExecutor } from "../../src/checks/runner/executor.js";
import { executeScanCommand } from "../../src/commands/scan.js";
import { main } from "../../src/cli.js";
import { createGitRepository } from "../helpers/git-repository.js";
import {
  DEFAULT_ANALYSIS_SESSION_DEPENDENCIES,
  withAnalysisSession,
} from "../../src/scan/analysis-session.js";

const acquire = vi.hoisted(() => vi.fn());
vi.mock("../../src/service/client.js", async (original) => ({
  ...(await original<typeof import("../../src/service/client.js")>()),
  acquireServiceExecutor: acquire,
}));
afterEach(() => {
  vi.restoreAllMocks();
  acquire.mockReset();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

it("shares one prepared acquisition across concurrent opens without opening a source session early", async () => {
  const local = createLocalAnalyzerExecutor();
  const pending = deferred<typeof local>();
  acquire.mockReturnValue(pending.promise);
  const executor = createCommandExecutor();
  try {
    executor.prepare?.();
    expect(acquire).toHaveBeenCalledTimes(1);
    executor.prepare?.();
    const first = executor.openSession(),
      second = executor.openSession();
    expect(acquire).toHaveBeenCalledTimes(1);
    pending.resolve(local);
    const sessions = await Promise.all([first, second]);
    expect(sessions[0]).not.toBe(sessions[1]);
    await Promise.all(sessions.map((session) => session.close()));
  } finally {
    pending.resolve(local);
    await executor.close();
    await local.close();
  }
});

it("close-before-open awaits prepared acquisition and closes its returned owner", async () => {
  const local = createLocalAnalyzerExecutor();
  const pending = deferred<typeof local>();
  acquire.mockReturnValue(pending.promise);
  const executor = createCommandExecutor();
  executor.prepare?.();
  let closed = false;
  const closing = executor.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  pending.resolve(local);
  await closing;
  await expect(local.openSession()).rejects.toThrow();
  await expect(executor.openSession()).rejects.toThrow();
});

it("observes a prepared failure immediately and preserves it for openSession", async () => {
  const pending = deferred<ReturnType<typeof createLocalAnalyzerExecutor>>();
  const failure = new Error("identity failure");
  acquire.mockReturnValue(pending.promise);
  const executor = createCommandExecutor();
  executor.prepare?.();
  expect(acquire).toHaveBeenCalledTimes(1);
  pending.reject(failure);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await expect(executor.openSession()).rejects.toBe(failure);
  await executor.close();
});

it("help and an actual empty index never acquire the service", async () => {
  const output = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(() => true);
  expect(await main([process.execPath, "zedbee", "scan", "--help"])).toBe(0);
  output.mockRestore();
  const repository = await createGitRepository("zedbee-empty-acquisition-");
  const stdout: string[] = [];
  expect(
    await executeScanCommand(
      { cwd: repository.root, format: "json", color: false, animations: false },
      {
        stdinIsTTY: false,
        stdoutIsTTY: false,
        width: 80,
        env: {},
        writeStdout: (value) => stdout.push(value),
        writeStderr: () => {},
      },
    ),
  ).toBe(0);
  expect(JSON.parse(stdout.join("")).summary.incomplete).toBe(0);
  expect(acquire).not.toHaveBeenCalled();
});

it("command snapshot failure still awaits and closes the prepared acquisition", async () => {
  const repository = await createGitRepository("zedbee-prepared-failure-");
  await repository.write("index.js", "export const value = 1;\n");
  await repository.git(["add", "index.js"]);
  const local = createLocalAnalyzerExecutor();
  const pending = deferred<typeof local>(),
    snapshot = deferred<void>();
  acquire.mockReturnValue(pending.promise);
  let settled = false;
  const command = executeScanCommand(
    { cwd: repository.root, format: "json", color: false, animations: false },
    {
      stdinIsTTY: false,
      stdoutIsTTY: false,
      width: 80,
      env: {},
      writeStdout: () => {},
      writeStderr: () => {},
    },
    {
      resolveRepositoryRoot: async () => repository.root,
      scan: async (options) => {
        const outcome = await withAnalysisSession(
          {
            ...options,
            dependencies: {
              ...DEFAULT_ANALYSIS_SESSION_DEPENDENCIES,
              buildIndexSnapshots: async () => {
                snapshot.resolve();
                throw new Error("snapshot failed");
              },
            },
          },
          async () => {
            throw new Error("unreachable");
          },
        );
        if (!outcome.completed) throw outcome.error;
        return outcome.value;
      },
      openInk: async () => {
        throw new Error("unreachable");
      },
      preparePresentation: async () => {
        throw new Error("unreachable");
      },
    },
  );
  void command.then(() => {
    settled = true;
  });
  try {
    await snapshot.promise;
    expect(acquire).toHaveBeenCalledTimes(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
  } finally {
    pending.resolve(local);
  }
  expect(await command).toBe(2);
  await expect(local.openSession()).rejects.toThrow();
});
