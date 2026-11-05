import { ProjectPrettierFailureError } from "./project-error.js";
export { ProjectPrettierFailureError } from "./project-error.js";
export { snapshotIdentity } from "./project-snapshot-identity.js";
export { resolveProjectPrettierInstallation } from "./project-installation.js";
import { fork, type ChildProcess, type Serializable } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  projectPrettierPermitAllows,
  type ProjectPrettierPermit,
} from "./project-trust.js";
import type {
  ImportableNativeConfig,
  ProjectFormatSupport,
  ProjectFormatResult,
  ProjectPrettierFailure,
  ProjectPrettierInstallation,
  ProjectPrettierReply,
  ProjectPrettierRequest,
} from "./project-types.js";
import {
  parseProjectReply,
  PROJECT_PROTOCOL_MAX_BYTES,
} from "./project-protocol.js";
import {
  createProjectWorkspace,
  ProjectWorkspaceLayoutError,
  type ProjectWorkspace,
} from "./project-workspace.js";
import { createProjectProcessOwner } from "./project-process.js";

const READY_TIMEOUT_MS = 10_000;
const CLOSE_GRACE_MS = 2_000;

export interface ProjectFormatterSession {
  classify(file: string): Promise<ProjectFormatSupport>;
  format(file: string, source: string): Promise<ProjectFormatResult>;
  readConfigForImport(configPath: string): Promise<ImportableNativeConfig>;
  /** Consent-required evaluation of a package-exported shared configuration. */
  readSharedConfigForImport(
    configPackage: string,
    originConfig?: string,
  ): Promise<ImportableNativeConfig>;
  close(): Promise<void>;
}

export interface ProjectFormatterInput {
  readonly checkoutRoot: string;
  readonly snapshotRoot: string;
  readonly projectRoot: string;
  readonly installation: ProjectPrettierInstallation;
  readonly permit: ProjectPrettierPermit;
  readonly signal: AbortSignal;
  /** Borrowed captured import workspace; the caller owns its lifetime. */
  readonly importWorkspace?: ProjectWorkspace;
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

export function owningProjectRoot(
  workspaces: readonly { readonly relativeRoot: string }[],
  file: string,
): string {
  const candidates = workspaces
    .filter(
      (workspace) =>
        workspace.relativeRoot === "." ||
        file.startsWith(`${workspace.relativeRoot}/`),
    )
    .sort(
      (left, right) => right.relativeRoot.length - left.relativeRoot.length,
    );
  return candidates[0]?.relativeRoot ?? ".";
}

interface PendingRequest {
  readonly expectedOperation: "classify" | "format" | "importConfig";
  readonly resolve: (reply: ProjectPrettierReply) => void;
  readonly reject: (error: unknown) => void;
}

function pendingFailure(
  projectRoot: string,
  message: string,
): ProjectPrettierFailure {
  return {
    code: "PROJECT_PRETTIER_WORKER_FAILED",
    message,
    projectRoot,
  };
}

async function openSession(
  input: ProjectFormatterInput,
): Promise<ProjectFormatterSession> {
  if (input.signal.aborted) {
    throw new ProjectPrettierFailureError(
      pendingFailure(input.projectRoot, "The project formatter was cancelled."),
    );
  }
  if (
    !projectPrettierPermitAllows(
      input.permit,
      input.checkoutRoot,
      input.projectRoot,
    )
  ) {
    throw new ProjectPrettierFailureError({
      code: "PROJECT_PRETTIER_TRUST_REQUIRED",
      message: "Project Prettier execution requires explicit trust.",
      projectRoot: input.projectRoot,
    });
  }
  let workspace: ProjectWorkspace;
  try {
    workspace =
      input.importWorkspace ??
      (await createProjectWorkspace(
        {
          repositoryRoot: input.checkoutRoot,
          snapshotRoot: input.snapshotRoot,
          projectRoot: input.projectRoot,
        },
        input.signal,
      ));
  } catch (error) {
    if (error instanceof ProjectWorkspaceLayoutError) {
      throw new ProjectPrettierFailureError({
        code: "PROJECT_PRETTIER_LAYOUT_UNSUPPORTED",
        message: error.message,
        projectRoot: input.projectRoot,
      });
    }
    throw error;
  }
  const releaseWorkspace = input.importWorkspace?.acquireUse();
  // A borrowed mirror is never deleted while another session may still need it.
  const disposeWorkspace = async (): Promise<void> => {
    if (input.importWorkspace === undefined) await workspace.dispose();
    else releaseWorkspace?.();
  };
  const workerEntry = fileURLToPath(
    new URL(
      `./project-worker.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
      import.meta.url,
    ),
  );
  const owner = await createProjectProcessOwner().catch(async () => {
    await disposeWorkspace();
    throw new ProjectPrettierFailureError(
      pendingFailure(
        input.projectRoot,
        "The project formatter process owner could not be created.",
      ),
    );
  });
  const bootstrap = fileURLToPath(
    new URL(
      `../runner/bootstrap.${import.meta.url.endsWith(".ts") ? "ts" : "js"}`,
      import.meta.url,
    ),
  );
  let child: ChildProcess;
  try {
    child = fork(bootstrap, [], {
      cwd:
        input.importWorkspace === undefined
          ? workspace.workerCwd
          : resolve(workspace.treeRoot, input.projectRoot),
      env: minimalEnvironment(workspace.root),
      execArgv: [...sourceExecArgv()],
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      detached: process.platform !== "win32",
      serialization: "advanced",
    });
  } catch {
    await owner.stop();
    await disposeWorkspace();
    throw new ProjectPrettierFailureError(
      pendingFailure(
        input.projectRoot,
        "The project formatter could not be started.",
      ),
    );
  }
  // Native ownership is established before sending owned-start. A failed
  // termination retains both the owner and mirror; it is never proof of exit.
  let cleanupPromise: Promise<void> | undefined;
  const cleanup = (): Promise<void> =>
    (cleanupPromise ??= (async () => {
      try {
        await owner.stop();
      } catch {
        throw new ProjectPrettierFailureError(
          pendingFailure(
            input.projectRoot,
            "Project formatter cleanup could not be verified; its workspace was retained.",
          ),
        );
      }
      await disposeWorkspace();
    })());

  try {
    if (child.pid !== undefined) owner.assign(child.pid);
  } catch {
    child.kill(); // Assignment failed while only the inert bootstrap existed.
    await cleanup();
    throw new ProjectPrettierFailureError(
      pendingFailure(
        input.projectRoot,
        "The project formatter process could not be owned.",
      ),
    );
  }
  const pending = new Map<number, PendingRequest>();
  let nextId = 1;
  let closed = false;
  let workerExited = false;
  let protocolFailure: ProjectPrettierFailure | undefined;
  const failAll = (failure: ProjectPrettierFailure): void => {
    for (const request of pending.values()) {
      request.reject(new ProjectPrettierFailureError(failure));
    }
    pending.clear();
  };
  const invalidateProtocol = (): void => {
    if (protocolFailure !== undefined) return;
    protocolFailure = {
      code: "PROJECT_PRETTIER_PROTOCOL_INVALID",
      message: "The project formatter returned an invalid response.",
      projectRoot: input.projectRoot,
    };
    failAll(protocolFailure);
    void cleanup().catch(() => undefined);
  };

  // Startup cancellation and early worker death must reject the pending
  // `ready` handshake immediately; nothing waits out the startup timer.
  let settleReady: ((error: ProjectPrettierFailure) => void) | undefined;
  const readyAborted = new Promise<void>((_, rejectReady) => {
    settleReady = (failure) =>
      rejectReady(new ProjectPrettierFailureError(failure));
  });
  const exited = new Promise<void>((resolveExit) => {
    child.once("exit", () => {
      workerExited = true;
      resolveExit();
    });
  });
  // A dead worker must fail its pending work immediately; the caller's
  // cancellation signal governs every deadline from here on.
  child.once("exit", () => {
    const failure = pendingFailure(
      input.projectRoot,
      "The project formatter exited before completing its work.",
    );
    failAll(failure);
    settleReady?.(failure);
  });

  child.on("message", (message: unknown) => {
    const value = message as { type?: string; reply?: unknown } | null;
    if (value?.type !== "reply") return;
    const reply = value.reply as { id?: unknown } | undefined;
    const id = typeof reply?.id === "number" ? reply.id : undefined;
    if (id === undefined) {
      invalidateProtocol();
      return;
    }
    const request = pending.get(id);
    if (request === undefined) {
      invalidateProtocol();
      return;
    }
    try {
      const parsed = parseProjectReply(value.reply, id);
      if (parsed.operation === "error") {
        pending.delete(id);
        request.reject(new ProjectPrettierFailureError(parsed.failure));
      } else if (parsed.operation !== request.expectedOperation) {
        throw new TypeError("Reply operation mismatch");
      } else {
        pending.delete(id);
        request.resolve(parsed);
      }
    } catch {
      invalidateProtocol();
    }
  });

  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const timer = (readyTimer = setTimeout(() => {
      rejectReady(
        new ProjectPrettierFailureError(
          pendingFailure(
            input.projectRoot,
            "The project formatter did not start in time.",
          ),
        ),
      );
    }, READY_TIMEOUT_MS));
    const onMessage = (message: unknown): void => {
      const type = (message as { type?: string } | null)?.type;
      if (type === "ready-for-ownership") {
        try {
          if (child.pid === undefined) throw new Error("Missing worker PID");
          owner.assign(child.pid);
          if (input.signal.aborted) throw new Error("Cancelled");
          child.send(
            {
              type: "owned-start",
              workerEntry,
              request: {
                type: "init",
                installation: { entryUrl: input.installation.entryUrl },
                treeRoot: workspace.treeRoot,
                projectRoot: input.projectRoot,
                capturedImportSources: workspace.importProvenance !== undefined,
              },
            },
            (error) => {
              if (error) rejectReady(error);
            },
          );
        } catch (error) {
          child.kill(); // Only the inert bootstrap has started if assignment failed.
          rejectReady(error);
        }
        return;
      }
      if (type !== "ready") return;
      clearTimeout(timer);
      child.off("message", onMessage);
      resolveReady();
    };
    child.on("message", onMessage);
    child.once("error", () => {
      clearTimeout(timer);
      rejectReady(
        new ProjectPrettierFailureError(
          pendingFailure(
            input.projectRoot,
            "The project formatter could not be started.",
          ),
        ),
      );
    });
  });

  const abort = (): void => {
    // Cancellation ends the process tree and the owned workspace promptly,
    // including while startup is still waiting for the worker; the ready
    // handshake rejects immediately instead of waiting out its timer.
    const failure = pendingFailure(
      input.projectRoot,
      "The project formatter was cancelled.",
    );
    failAll(failure);
    settleReady?.(failure);
    void cleanup().catch(() => undefined);
  };
  input.signal.addEventListener("abort", abort, { once: true });
  if (input.signal.aborted) abort();

  try {
    await Promise.race([ready, readyAborted]);
  } catch (error) {
    input.signal.removeEventListener("abort", abort);
    await cleanup();
    throw error;
  } finally {
    clearTimeout(readyTimer);
  }

  const request = (
    operation: "classify" | "format" | "importConfig",
    payload: Record<string, unknown>,
  ): Promise<ProjectPrettierReply> => {
    if (protocolFailure !== undefined) {
      return Promise.reject(new ProjectPrettierFailureError(protocolFailure));
    }
    if (closed || workerExited) {
      return Promise.reject(
        new ProjectPrettierFailureError(
          pendingFailure(
            input.projectRoot,
            "The project formatter is not available.",
          ),
        ),
      );
    }
    const id = nextId++;
    return new Promise((resolveRequest, rejectRequest) => {
      pending.set(id, {
        expectedOperation: operation,
        resolve: resolveRequest,
        reject: rejectRequest,
      });
      const message = {
        type: "request",
        request: { id, operation, ...payload },
      };
      const serialized = JSON.stringify(message);
      if (
        Buffer.byteLength(serialized, "utf8") >
        PROJECT_PROTOCOL_MAX_BYTES * 4
      ) {
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
          pending.delete(id);
          rejectRequest(
            new ProjectPrettierFailureError(
              pendingFailure(
                input.projectRoot,
                "The project formatter could not receive the request.",
              ),
            ),
          );
        }
      });
    });
  };

  return Object.freeze({
    async classify(file: string): Promise<ProjectFormatSupport> {
      const reply = await request("classify", { file });
      if (reply.operation !== "classify") throw new Error("Unexpected reply");
      return reply.result;
    },
    async format(file: string, source: string): Promise<ProjectFormatResult> {
      const reply = await request("format", { file, source });
      if (reply.operation !== "format") throw new Error("Unexpected reply");
      return reply.result;
    },
    async readConfigForImport(
      configPath: string,
    ): Promise<ImportableNativeConfig> {
      const reply = await request("importConfig", { configFile: configPath });
      if (reply.operation !== "importConfig")
        throw new Error("Unexpected reply");
      return reply.result;
    },
    async readSharedConfigForImport(
      configPackage: string,
      originConfig?: string,
    ): Promise<ImportableNativeConfig> {
      const reply = await request("importConfig", {
        configPackage,
        ...(originConfig === undefined ? {} : { originConfig }),
      });
      if (reply.operation !== "importConfig")
        throw new Error("Unexpected reply");
      return reply.result;
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      input.signal.removeEventListener("abort", abort);
      failAll(
        pendingFailure(
          input.projectRoot,
          "The project formatter session was closed.",
        ),
      );
      try {
        child.send({ type: "close" } as Serializable, () => {});
      } catch {
        /* Already gone. */
      }
      await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolveRace) =>
          setTimeout(() => resolveRace(false), CLOSE_GRACE_MS),
        ),
      ]);
      await cleanup();
    },
  });
}

export async function openProjectFormatter(
  input: ProjectFormatterInput,
): Promise<ProjectFormatterSession> {
  return openSession(input);
}
