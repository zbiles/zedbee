import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";

const LOCAL_RUN_TIMEOUT_MS = 60 * 60 * 1000;

export async function superviseRun(nodeArguments, options = {}) {
  const env = options.env ?? process.env;
  // Actions owns the job deadline. Locally, one supervisor bounds the entire
  // verification process, including setup and cleanup, rather than each test.
  const timeout =
    env.GITHUB_ACTIONS === "true"
      ? undefined
      : (options.timeoutMs ?? LOCAL_RUN_TIMEOUT_MS);
  const result = await execa(process.execPath, nodeArguments, {
    env,
    extendEnv: false,
    stdio: options.stdio ?? "inherit",
    reject: false,
    killDescendants: true,
    // Do not let a SIGTERM-ignoring descendant survive the deadline after its
    // parent exits. Windows maps this to forceful task-tree termination.
    killSignal: "SIGKILL",
    ...(options.cancelSignal === undefined
      ? {}
      : { cancelSignal: options.cancelSignal }),
    ...(timeout === undefined ? {} : { timeout }),
  });
  return {
    exitCode: result.timedOut ? 124 : (result.exitCode ?? 1),
    timedOut: result.timedOut,
  };
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  const result = await superviseRun(process.argv.slice(2));
  if (result.timedOut) {
    process.stderr.write(
      "The complete local verification run exceeded its 60-minute limit.\n",
    );
  }
  process.exitCode = result.exitCode;
}
