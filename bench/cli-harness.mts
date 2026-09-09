import { execa } from "execa";
import { fileURLToPath } from "node:url";

/** Wall time starts before process creation and ends after natural process exit. */
export async function runCompleteCli(options: {
  repositoryRoot: string;
  args: readonly string[];
  cliPath?: string;
  env?: NodeJS.ProcessEnv;
}) {
  const start = performance.now();
  const result = await execa(
    process.execPath,
    [
      options.cliPath ??
        fileURLToPath(new URL("../dist/cli.js", import.meta.url)),
      ...options.args,
    ],
    {
      cwd: options.repositoryRoot,
      env: {
        ...options.env,
        ZEDBEE_NO_UPDATE_CHECK: "1",
        NODE_OPTIONS: "",
        NODE_PATH: "",
      },
      reject: false,
      stdin: "ignore",
    },
  );
  const durationMs = performance.now() - start;
  let blockedScan = false;
  if (options.args[0] === "scan" && result.exitCode === 1) {
    try {
      const report = JSON.parse(result.stdout);
      blockedScan =
        report.outcome === "blocked" &&
        report.exitCode === 1 &&
        report.summary.incomplete === 0;
    } catch {
      /* Human output is not a benchmark result. */
    }
  }
  if (result.exitCode !== 0 && !blockedScan)
    throw new Error(
      `CLI command failed (${result.exitCode ?? result.signal}): ${result.stderr || result.stdout}`,
    );
  return {
    exitCode: result.exitCode!,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs,
  };
}
