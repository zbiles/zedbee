import { fork } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createProjectProcessOwner } from "../../prettier/project-process.js";
import { createProjectEslintWorkspace } from "./workspace.js";
import { resolveProjectEslintInstallation } from "./installation.js";
import { normalizeProjectRoot, projectEslintPermitAllows } from "./trust.js";
import {
  parseProjectEslintResult,
  PROJECT_ESLINT_MAX_BYTES,
  PROJECT_ESLINT_MAX_FILES,
  validProjectEslintPath,
} from "./protocol.js";
import {
  ProjectEslintFailureError,
  type ProjectEslintInput,
  type ProjectEslintRequest,
  type ProjectEslintResult,
} from "./types.js";
export { ProjectEslintFailureError } from "./types.js";
export type {
  ProjectEslintInput,
  ProjectEslintResult,
  ProjectEslintDiagnostic,
} from "./types.js";

const MAX_RUN_MS = 30_000;
const WORKER_FAILURE_CODES = new Set([
  "PROJECT_ESLINT_CONFIG_INVALID",
  "PROJECT_ESLINT_CONFIG_UNSUPPORTED",
  "PROJECT_ESLINT_OUTPUT_LIMIT",
  "PROJECT_ESLINT_VERSION_UNSUPPORTED",
]);

export async function runProjectEslint(
  input: ProjectEslintInput,
): Promise<ProjectEslintResult> {
  if (input.signal.aborted)
    throw new ProjectEslintFailureError("PROJECT_ESLINT_CANCELLED");
  const checkoutRoot = await realpath(input.checkoutRoot).catch(() => {
    throw new ProjectEslintFailureError("PROJECT_ESLINT_LAYOUT_UNSUPPORTED");
  });
  const projectRoot = normalizeProjectRoot(input.projectRoot);
  if (!projectEslintPermitAllows(input.permit, checkoutRoot, projectRoot))
    throw new ProjectEslintFailureError("PROJECT_ESLINT_TRUST_REQUIRED");
  const fullMessages = input.messages === "full";
  if (
    fullMessages &&
    (!input.allowSourceMessages ||
      !projectEslintPermitAllows(input.permit, checkoutRoot, projectRoot, true))
  )
    throw new ProjectEslintFailureError(
      "PROJECT_ESLINT_MESSAGES_TRUST_REQUIRED",
    );
  if (
    input.files.length > PROJECT_ESLINT_MAX_FILES ||
    new Set(input.files).size !== input.files.length ||
    input.files.some(
      (file) =>
        !validProjectEslintPath(file) ||
        (projectRoot !== "." && !file.startsWith(`${projectRoot}/`)),
    )
  )
    throw new ProjectEslintFailureError("PROJECT_ESLINT_PROTOCOL_INVALID");
  const installation = await resolveProjectEslintInstallation(
    checkoutRoot,
    projectRoot,
    input.installationSnapshotRoot ?? input.snapshotRoot,
  );
  if (input.signal.aborted)
    throw new ProjectEslintFailureError("PROJECT_ESLINT_CANCELLED");
  const { workspace, configFile } = await createProjectEslintWorkspace({
    ...input,
    checkoutRoot,
    projectRoot,
  });
  const owner = await createProjectProcessOwner().catch(async () => {
    await workspace.dispose();
    throw new ProjectEslintFailureError("PROJECT_ESLINT_WORKER_FAILED");
  });
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    LANG: "C",
    LC_ALL: "C",
    HOME: workspace.root,
    TMPDIR: workspace.root,
  };
  if (process.platform === "win32") {
    environment.SystemRoot = process.env.SystemRoot;
    environment.WINDIR = process.env.WINDIR;
  }
  let cleanupFailure = false;
  try {
    const child = fork(
      fileURLToPath(
        new URL(`../../runner/bootstrap.${extension}`, import.meta.url),
      ),
      [],
      {
        cwd: workspace.workerCwd,
        env: environment,
        execArgv:
          extension === "ts" ? ["--import", import.meta.resolve("tsx")] : [],
        stdio: ["ignore", "ignore", "ignore", "ipc", "pipe"],
        detached: process.platform !== "win32",
        serialization: "json",
      },
    );
    child.on("error", () => {});
    if (child.pid === undefined)
      throw new ProjectEslintFailureError("PROJECT_ESLINT_WORKER_FAILED");
    try {
      owner.assign(child.pid);
    } catch {
      child.kill();
      throw new ProjectEslintFailureError("PROJECT_ESLINT_WORKER_FAILED");
    }
    const request: ProjectEslintRequest = {
      type: "run",
      treeRoot: workspace.treeRoot,
      projectRoot,
      configFile,
      installation,
      files: input.files,
      fullMessages,
    };
    if (Buffer.byteLength(JSON.stringify(request)) > PROJECT_ESLINT_MAX_BYTES)
      throw new ProjectEslintFailureError("PROJECT_ESLINT_OUTPUT_LIMIT");
    return await new Promise<ProjectEslintResult>((resolve, reject) => {
      let settled = false,
        started = false,
        count = 0;
      const chunks: Buffer[] = [];
      const finish = (
        error?: ProjectEslintFailureError,
        result?: ProjectEslintResult,
      ): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(result!);
      };
      const abort = (): void =>
        finish(new ProjectEslintFailureError("PROJECT_ESLINT_CANCELLED"));
      const timer = setTimeout(
        () => finish(new ProjectEslintFailureError("PROJECT_ESLINT_TIMEOUT")),
        MAX_RUN_MS,
      );
      input.signal.addEventListener("abort", abort, { once: true });
      child.on("error", () =>
        finish(new ProjectEslintFailureError("PROJECT_ESLINT_WORKER_FAILED")),
      );
      child.on("exit", () =>
        finish(new ProjectEslintFailureError("PROJECT_ESLINT_WORKER_FAILED")),
      );
      child.on("message", (raw: unknown) => {
        const type =
          typeof raw === "object" && raw !== null
            ? (raw as { type?: unknown }).type
            : undefined;
        if (type !== "ready-for-ownership" || started) {
          finish(
            new ProjectEslintFailureError("PROJECT_ESLINT_PROTOCOL_INVALID"),
          );
          return;
        }
        started = true;
        if (input.signal.aborted) {
          abort();
          return;
        }
        owner.assign(child.pid!);
        child.send(
          {
            type: "owned-start",
            workerEntry: fileURLToPath(
              new URL(`./worker.${extension}`, import.meta.url),
            ),
            request,
          },
          (error) => {
            if (error)
              finish(
                new ProjectEslintFailureError("PROJECT_ESLINT_WORKER_FAILED"),
              );
          },
        );
      });
      const output = child.stdio[4];
      if (!output || !("on" in output)) {
        finish(new ProjectEslintFailureError("PROJECT_ESLINT_WORKER_FAILED"));
        return;
      }
      output.on("data", (chunk: Buffer) => {
        if (settled) return;
        count += chunk.length;
        if (count > PROJECT_ESLINT_MAX_BYTES + 1) {
          finish(new ProjectEslintFailureError("PROJECT_ESLINT_OUTPUT_LIMIT"));
          return;
        }
        chunks.push(chunk);
        if (!chunk.includes(10)) return;
        try {
          const text = Buffer.concat(chunks).toString("utf8");
          if (!text.endsWith("\n") || text.indexOf("\n") !== text.length - 1)
            throw new Error("Invalid frame");
          const reply = JSON.parse(text) as {
            ok?: unknown;
            code?: unknown;
            result?: unknown;
          };
          if (reply.ok === true) {
            const parsed = parseProjectEslintResult(reply.result, input.files);
            if (parsed.diagnostics.some((d) => d.fatal)) {
              finish(
                new ProjectEslintFailureError("PROJECT_ESLINT_CONFIG_INVALID"),
              );
              return;
            }
            // Defend privacy again after parsing, including against worker/plugin protocol tampering.
            finish(undefined, {
              ...parsed,
              messages: fullMessages ? "full" : "redacted",
              diagnostics: parsed.diagnostics.map((d) => ({
                ...d,
                message: fullMessages
                  ? d.message.replace(/[\x00-\x1f\x7f-\x9f]/gu, " ")
                  : "The project's ESLint reported a diagnostic.",
              })),
            });
          } else if (
            reply.ok === false &&
            typeof reply.code === "string" &&
            WORKER_FAILURE_CODES.has(reply.code)
          )
            finish(
              new ProjectEslintFailureError(
                reply.code as ConstructorParameters<
                  typeof ProjectEslintFailureError
                >[0],
              ),
            );
          else throw new Error("Invalid reply");
        } catch {
          finish(
            new ProjectEslintFailureError("PROJECT_ESLINT_PROTOCOL_INVALID"),
          );
        }
      });
      if (input.signal.aborted) abort();
    });
  } catch (error) {
    if (error instanceof ProjectEslintFailureError) throw error;
    throw new ProjectEslintFailureError("PROJECT_ESLINT_WORKER_FAILED");
  } finally {
    try {
      await owner.stop();
    } catch {
      cleanupFailure = true;
    }
    if (cleanupFailure)
      throw new ProjectEslintFailureError("PROJECT_ESLINT_WORKER_FAILED");
    await workspace.dispose().catch(() => {
      throw new ProjectEslintFailureError("PROJECT_ESLINT_WORKER_FAILED");
    });
  }
}
