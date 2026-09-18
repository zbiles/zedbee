import { createHash } from "node:crypto";
import {
  fork,
  type ChildProcess,
  type Serializable,
} from "node:child_process";
import { createRequire } from "node:module";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compareCodeUnits } from "../../core/compare.js";
import { isContainedPath } from "../../inspection/read-json.js";
import {
  projectPrettierPermitAllows,
  type ProjectPrettierPermit,
} from "./project-trust.js";
import type {
  ImportableNativeConfig,
  ProjectFormatResult,
  ProjectPrettierFailure,
  ProjectPrettierInstallation,
  ProjectPrettierReply,
  ProjectPrettierRequest,
} from "./project-types.js";
import { parseProjectReply, PROJECT_PROTOCOL_MAX_BYTES } from "./project-protocol.js";
import {
  createProjectWorkspace,
  type DependencyRoot,
  type ProjectWorkspace,
} from "./project-workspace.js";
import { stopProcessGroup } from "../runner/process-group.js";

const READY_TIMEOUT_MS = 10_000;
const CLOSE_GRACE_MS = 2_000;

export class ProjectPrettierFailureError extends Error {
  readonly code: ProjectPrettierFailure["code"];
  readonly failure: ProjectPrettierFailure;

  constructor(failure: ProjectPrettierFailure) {
    super(failure.message);
    this.name = "ProjectPrettierFailureError";
    this.code = failure.code;
    this.failure = failure;
    Object.freeze(this);
  }
}

export interface ProjectFormatterSession {
  format(file: string, source: string): Promise<ProjectFormatResult>;
  readConfigForImport(configPath: string): Promise<ImportableNativeConfig>;
  close(): Promise<void>;
}

export interface ProjectFormatterInput {
  readonly checkoutRoot: string;
  readonly snapshotRoot: string;
  readonly projectRoot: string;
  readonly installation: ProjectPrettierInstallation;
  readonly permit: ProjectPrettierPermit;
  readonly signal: AbortSignal;
}

function sourceExecArgv(): readonly string[] {
  return import.meta.url.endsWith(".ts")
    ? ["--import", import.meta.resolve("tsx")]
    : [];
}

function minimalEnvironment(workspaceRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "",
    LANG: process.env.LANG ?? "C",
    LC_ALL: process.env.LC_ALL ?? "C",
    HOME: workspaceRoot,
    TMPDIR: workspaceRoot,
  };
  if (process.platform === "win32") {
    environment.SystemRoot = process.env.SystemRoot;
    environment.WINDIR = process.env.WINDIR;
  }
  return environment;
}

async function dependencyRoots(
  repositoryRoot: string,
): Promise<readonly DependencyRoot[]> {
  const roots: DependencyRoot[] = [];
  const add = async (relativePath: string): Promise<void> => {
    const absolute = resolve(repositoryRoot, relativePath);
    try {
      const canonical = await realpath(absolute);
      const metadata = await lstat(canonical);
      if (metadata.isDirectory()) {
        roots.push({ relativePath, absolutePath: canonical });
      }
    } catch {
      /* Missing dependency directories are simply not linked. */
    }
  };
  await add("node_modules");
  let entries;
  try {
    entries = await readdir(repositoryRoot, { withFileTypes: true });
  } catch {
    return Object.freeze(roots);
  }
  for (const entry of entries.sort((left, right) =>
    compareCodeUnits(left.name, right.name),
  )) {
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const candidate = join(repositoryRoot, entry.name, "node_modules");
    try {
      await lstat(candidate);
      await add(`${entry.name}/node_modules`.replaceAll("\\", "/"));
    } catch {
      /* Not a workspace dependency directory. */
    }
  }
  return Object.freeze(roots);
}

async function resolveEntryUrl(packageRoot: string): Promise<string> {
  const manifestPath = join(packageRoot, "package.json");
  const esmEntry = join(packageRoot, "index.mjs");
  try {
    const metadata = await lstat(esmEntry);
    if (metadata.isFile()) return pathToFileURL(esmEntry).href;
  } catch {
    /* Fall through to package exports. */
  }
  const require = createRequire(manifestPath);
  try {
    return pathToFileURL(require.resolve("prettier")).href;
  } catch {
    /* Fall through to declared entry points. */
  }
  const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
    main?: string;
    module?: string;
  };
  const candidate =
    (typeof manifest.module === "string" && join(packageRoot, manifest.module)) ||
    (typeof manifest.main === "string" && join(packageRoot, manifest.main));
  if (typeof candidate === "string") {
    return pathToFileURL(resolve(candidate)).href;
  }
  return pathToFileURL(join(packageRoot, "index.mjs")).href;
}

export async function resolveProjectPrettierInstallation(
  repositoryRoot: string,
  projectRoot: string,
  declaredRange = "*",
): Promise<ProjectPrettierInstallation> {
  const checkoutRoot = await realpath(repositoryRoot);
  let current = await realpath(resolve(repositoryRoot, projectRoot)).catch(
    () => resolve(repositoryRoot, projectRoot),
  );
  while (isContainedPath(checkoutRoot, current)) {
    const manifestPath = join(current, "node_modules", "prettier", "package.json");
    try {
      const canonical = await realpath(manifestPath);
      if (!isContainedPath(checkoutRoot, canonical)) break;
      const bytes = await readFile(canonical);
      const manifest = JSON.parse(bytes.toString("utf8")) as {
        version?: unknown;
      };
      if (typeof manifest.version !== "string") break;
      const packageRoot = dirname(canonical);
      const entryUrl = await resolveEntryUrl(packageRoot);
      const identity = createHash("sha256")
        .update(entryUrl)
        .update("\0")
        .update(bytes)
        .update("\0")
        .update(packageRoot)
        .digest("hex");
      return Object.freeze({
        projectRoot: projectRoot === "" ? "." : projectRoot,
        packageRoot,
        entryUrl,
        version: manifest.version,
        declaredRange,
        identity,
      });
    } catch {
      /* Try the next hoisted level. */
    }
    if (current === checkoutRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new ProjectPrettierFailureError({
    code: "PROJECT_PRETTIER_INSTALL_MISSING",
    message: "No supported project Prettier installation was found.",
    projectRoot: projectRoot === "" ? "." : projectRoot,
  });
}

interface PendingRequest {
  readonly expectedOperation: "format" | "importConfig";
  readonly resolve: (reply: ProjectPrettierReply) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

async function openSession(
  input: ProjectFormatterInput,
  installation: ProjectPrettierInstallation,
): Promise<ProjectFormatterSession> {
  if (!projectPrettierPermitAllows(input.permit, input.checkoutRoot, input.projectRoot)) {
    throw new ProjectPrettierFailureError({
      code: "PROJECT_PRETTIER_TRUST_REQUIRED",
      message: "Project Prettier execution requires explicit trust.",
      projectRoot: input.projectRoot,
    });
  }
  const workspace: ProjectWorkspace = await createProjectWorkspace(
    {
      snapshotRoot: input.snapshotRoot,
      projectRoot: input.projectRoot,
      dependencyRoots: await dependencyRoots(input.checkoutRoot),
    },
    input.signal,
  );
  const workerEntry = fileURLToPath(
    new URL(
      `./project-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
      import.meta.url,
    ),
  );
  const child: ChildProcess = fork(workerEntry, [], {
    cwd: workspace.workerCwd,
    env: minimalEnvironment(workspace.root),
    execArgv: [...sourceExecArgv()],
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    detached: process.platform !== "win32",
    serialization: "advanced",
  });

  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let closed = false;
  let workerExited = false;
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => {
      workerExited = true;
      resolveExit();
    });
  });

  const failAll = (failure: ProjectPrettierFailure): void => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(new ProjectPrettierFailureError(failure));
    }
    pending.clear();
  };

  child.on("message", (message: unknown) => {
    const value = message as { type?: string; reply?: unknown } | null;
    if (value?.type !== "reply") return;
    const reply = value.reply as { id?: unknown } | undefined;
    const id = typeof reply?.id === "number" ? reply.id : undefined;
    if (id === undefined) return;
    const request = pending.get(id);
    if (request === undefined) return;
    pending.delete(id);
    clearTimeout(request.timer);
    try {
      const parsed = parseProjectReply(value.reply, id);
      if (parsed.operation === "error") {
        request.reject(new ProjectPrettierFailureError(parsed.failure));
      } else if (parsed.operation !== request.expectedOperation) {
        throw new TypeError("Reply operation mismatch");
      } else {
        request.resolve(parsed);
      }
    } catch {
      request.reject(
        new ProjectPrettierFailureError({
          code: "PROJECT_PRETTIER_PROTOCOL_INVALID",
          message: "The project formatter returned an invalid response.",
          projectRoot: input.projectRoot,
        }),
      );
    }
  });

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const timer = setTimeout(() => {
      rejectReady(
        new ProjectPrettierFailureError({
          code: "PROJECT_PRETTIER_WORKER_FAILED",
          message: "The project formatter did not start in time.",
          projectRoot: input.projectRoot,
        }),
      );
    }, READY_TIMEOUT_MS);
    const onMessage = (message: unknown): void => {
      if ((message as { type?: string } | null)?.type !== "ready") return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolveReady();
    };
    child.on("message", onMessage);
    child.once("error", () => {
      clearTimeout(timer);
      rejectReady(
        new ProjectPrettierFailureError({
          code: "PROJECT_PRETTIER_WORKER_FAILED",
          message: "The project formatter could not be started.",
          projectRoot: input.projectRoot,
        }),
      );
    });
  });

  const abort = (): void => {
    failAll({
      code: "PROJECT_PRETTIER_WORKER_FAILED",
      message: "The project formatter was cancelled.",
      projectRoot: input.projectRoot,
    });
  };
  input.signal.addEventListener("abort", abort, { once: true });

  try {
    child.send({
      type: "init",
      installation: { entryUrl: installation.entryUrl },
      treeRoot: workspace.treeRoot,
      projectRoot: input.projectRoot,
    } as Serializable);
    await ready;
  } catch (error) {
    input.signal.removeEventListener("abort", abort);
    child.kill("SIGKILL");
    await workspace.dispose();
    throw error;
  }

  const request = (
    operation: "format" | "importConfig",
    payload: Record<string, unknown>,
    timeoutMs = 30_000,
  ): Promise<ProjectPrettierReply> => {
    if (closed || workerExited) {
      return Promise.reject(
        new ProjectPrettierFailureError({
          code: "PROJECT_PRETTIER_WORKER_FAILED",
          message: "The project formatter is not available.",
          projectRoot: input.projectRoot,
        }),
      );
    }
    const id = nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        rejectRequest(
          new ProjectPrettierFailureError({
            code: "PROJECT_PRETTIER_WORKER_FAILED",
            message: "The project formatter timed out.",
            projectRoot: input.projectRoot,
          }),
        );
      }, timeoutMs);
      pending.set(id, {
        expectedOperation: operation,
        resolve: resolveRequest as PendingRequest["resolve"],
        reject: rejectRequest,
        timer,
      });
      const message = { type: "request", request: { id, operation, ...payload } };
      const serialized = JSON.stringify(message);
      if (Buffer.byteLength(serialized, "utf8") > PROJECT_PROTOCOL_MAX_BYTES * 4) {
        clearTimeout(timer);
        pending.delete(id);
        rejectRequest(
          new ProjectPrettierFailureError({
            code: "PROJECT_PRETTIER_OUTPUT_LIMIT",
            message: "The project formatter request exceeded its size limit.",
            projectRoot: input.projectRoot,
          }),
        );
        return;
      }
      child.send(message as Serializable, (error) => {
        if (error) {
          clearTimeout(timer);
          pending.delete(id);
          rejectRequest(
            new ProjectPrettierFailureError({
              code: "PROJECT_PRETTIER_WORKER_FAILED",
              message: "The project formatter could not receive the request.",
              projectRoot: input.projectRoot,
            }),
          );
        }
      });
    });
  };

  return Object.freeze({
    async format(file: string, source: string): Promise<ProjectFormatResult> {
      const reply = await request("format", { file, source });
      if (reply.operation !== "format") throw new Error("Unexpected reply");
      return reply.result;
    },
    async readConfigForImport(
      configPath: string,
    ): Promise<ImportableNativeConfig> {
      const reply = await request("importConfig", { configFile: configPath });
      if (reply.operation !== "importConfig") throw new Error("Unexpected reply");
      return reply.result;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      input.signal.removeEventListener("abort", abort);
      failAll({
        code: "PROJECT_PRETTIER_WORKER_FAILED",
        message: "The project formatter session was closed.",
        projectRoot: input.projectRoot,
      });
      try {
        child.send({ type: "close" } as Serializable, () => {});
      } catch {
        /* Already gone. */
      }
      const exitedGracefully = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolveRace) =>
          setTimeout(() => resolveRace(false), CLOSE_GRACE_MS),
        ),
      ]);
      if (!exitedGracefully && child.pid !== undefined) {
        await stopProcessGroup(child.pid);
      }
      await workspace.dispose();
    },
  });
}

export async function openProjectFormatter(
  input: ProjectFormatterInput,
): Promise<ProjectFormatterSession> {
  return openSession(input, input.installation);
}
