import { createHash } from "node:crypto";
import {
  fork,
  type ChildProcess,
  type Serializable,
} from "node:child_process";
import { createRequire } from "node:module";
import { lstat, open, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import semver from "semver";
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
  ProjectWorkspaceLayoutError,
  type ProjectWorkspace,
} from "./project-workspace.js";
import { stopProcessGroup } from "../runner/process-group.js";

const READY_TIMEOUT_MS = 10_000;
const CLOSE_GRACE_MS = 2_000;
const MAX_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 1024 * 1024;

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
  /** Consent-required evaluation of a package-exported shared configuration. */
  readSharedConfigForImport(configPackage: string): Promise<ImportableNativeConfig>;
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
    .sort((left, right) => right.relativeRoot.length - left.relativeRoot.length);
  return candidates[0]?.relativeRoot ?? ".";
}

/** Hashes all regular mirrored files (sorted path + bytes) for stale-plan checks. */
const IDENTITY_CHUNK_BYTES = 64 * 1024;
const MAX_IDENTITY_FILE_BYTES = 64 * 1024 * 1024;

/**
 * Hashes every regular mirrored file (sorted path and bytes) with fixed
 * memory: files stream through a bounded buffer instead of being loaded in
 * full, so one huge tracked asset cannot exhaust the Zedbee process.
 */
export async function snapshotIdentity(snapshotRoot: string): Promise<string> {
  const hash = createHash("sha256");
  const buffer = Buffer.alloc(IDENTITY_CHUNK_BYTES);
  const streamFile = async (absolute: string): Promise<void> => {
    const handle = await open(absolute, "r");
    try {
      while (true) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) return;
        hash.update(buffer.subarray(0, bytesRead));
      }
    } finally {
      await handle.close().catch(() => undefined);
    }
  };
  const walk = async (directory: string, prefix: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries.sort((left, right) =>
      compareCodeUnits(left.name, right.name),
    )) {
      if (entry.name === "node_modules") continue;
      const absolute = join(directory, entry.name);
      const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        await walk(absolute, relativePath);
        continue;
      }
      if (!metadata.isFile()) continue;
      if (metadata.size > BigInt(MAX_IDENTITY_FILE_BYTES)) {
        throw new ProjectPrettierFailureError({
          code: "PROJECT_PRETTIER_LAYOUT_UNSUPPORTED",
          message:
            "A snapshot file is too large to fingerprint for stale-plan checks.",
          projectRoot: ".",
        });
      }
      hash.update(relativePath, "utf8");
      hash.update("\0", "utf8");
      await streamFile(absolute);
      hash.update("\0", "utf8");
    }
  };
  await walk(snapshotRoot, "");
  return hash.digest("hex");
}

interface ManifestDeclaration {
  readonly range: string;
  readonly section: string;
}

function manifestPrettierDeclaration(
  value: unknown,
): ManifestDeclaration | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  for (const section of [
    "dependencies",
    "devDependencies",
    "optionalDependencies",
    "peerDependencies",
  ]) {
    const dependencies = (value as Record<string, unknown>)[section];
    if (typeof dependencies !== "object" || dependencies === null) continue;
    const specifier = (dependencies as Record<string, unknown>).prettier;
    if (typeof specifier === "string") {
      return { range: specifier, section };
    }
  }
  return undefined;
}

async function readBounded(path: string, maxBytes: number): Promise<string> {
  const metadata = await lstat(path);
  if (!metadata.isFile() || metadata.size > BigInt(maxBytes)) {
    throw new Error("unbounded read");
  }
  return readFile(path, "utf8");
}

/**
 * Resolves the Prettier declaration from the *selected snapshot*, never the
 * live working tree, so an unstaged manifest edit cannot change whether a
 * staged or committed scan may execute the formatter.
 */
async function snapshotPrettierDeclaration(
  snapshotRoot: string,
  projectRoot: string,
): Promise<ManifestDeclaration> {
  let directory = resolve(snapshotRoot, projectRoot);
  while (isContainedPath(snapshotRoot, directory)) {
    try {
      const manifest = JSON.parse(
        await readBounded(join(directory, "package.json"), MAX_MANIFEST_BYTES),
      );
      const declaration = manifestPrettierDeclaration(manifest);
      if (declaration !== undefined) return declaration;
    } catch {
      /* Missing or unreadable manifest; keep walking upward. */
    }
    if (directory === snapshotRoot) break;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new ProjectPrettierFailureError({
    code: "PROJECT_PRETTIER_INSTALL_MISSING",
    message:
      "The selected snapshot does not declare Prettier for this project.",
    projectRoot: projectRoot === "" ? "." : projectRoot,
  });
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
  const manifest = JSON.parse(
    await readFile(manifestPath, "utf8"),
  ) as {
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
  snapshotRoot: string,
): Promise<ProjectPrettierInstallation> {
  const checkoutRoot = await realpath(repositoryRoot);
  const declaration = await snapshotPrettierDeclaration(
    snapshotRoot,
    projectRoot,
  );
  const projectDirectory = resolve(repositoryRoot, projectRoot);
  let current = await realpath(projectDirectory).catch(() => projectDirectory);
  while (true) {
    const manifestPath = join(current, "node_modules", "prettier", "package.json");
    try {
      const canonicalManifest = await realpath(manifestPath);
      const manifestMetadata = await lstat(canonicalManifest);
      if (
        !manifestMetadata.isFile() ||
        manifestMetadata.size > BigInt(MAX_MANIFEST_BYTES)
      ) {
        throw new ProjectPrettierFailureError({
          code: "PROJECT_PRETTIER_INSTALL_MISSING",
          message: "The installed Prettier manifest is unreadable or too large.",
          projectRoot: projectRoot === "" ? "." : projectRoot,
        });
      }
      const bytes = await readFile(canonicalManifest);
      const manifest = JSON.parse(bytes.toString("utf8")) as {
        version?: unknown;
      };
      if (typeof manifest.version !== "string") break;
      const packageRoot = dirname(canonicalManifest);
      const entryUrl = await resolveEntryUrl(packageRoot);
      const normalizedVersion = semver.valid(manifest.version);
      if (
        normalizedVersion === null ||
        !semver.satisfies(normalizedVersion, ">=3.0.0 <4.0.0") ||
        !satisfiesDeclaredRange(normalizedVersion, declaration.range)
      ) {
        throw new ProjectPrettierFailureError({
          code: "PROJECT_PRETTIER_VERSION_UNSUPPORTED",
          message: `The installed Prettier ${manifest.version} does not satisfy the supported range >=3.0.0 <4.0.0 or the project's declared ${declaration.range}.`,
          projectRoot: projectRoot === "" ? "." : projectRoot,
        });
      }
      // Identity covers the executable entry bytes, the manifest bytes, and
      // the validated realpath, so an in-place engine swap is detectable. The
      // entry is stat-checked before reading: a too-large or unreadable entry
      // is an explicit failure, never a partial or empty-byte identity.
      const entryPath = fileURLToPath(entryUrl);
      const entryMetadata = await lstat(entryPath);
      if (
        !entryMetadata.isFile() ||
        entryMetadata.size > BigInt(MAX_ENTRY_BYTES)
      ) {
        throw new ProjectPrettierFailureError({
          code: "PROJECT_PRETTIER_INSTALL_MISSING",
          message:
            "The installed Prettier entry is unreadable or too large to validate.",
          projectRoot: projectRoot === "" ? "." : projectRoot,
        });
      }
      const entryHash = createHash("sha256");
      {
        const handle = await open(entryPath, "r");
        try {
          const chunk = Buffer.alloc(IDENTITY_CHUNK_BYTES);
          while (true) {
            const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
            if (bytesRead === 0) break;
            entryHash.update(chunk.subarray(0, bytesRead));
          }
        } finally {
          await handle.close().catch(() => undefined);
        }
      }
      const identity = createHash("sha256")
        .update(entryHash.digest())
        .update("\0")
        .update(bytes)
        .update("\0")
        .update(packageRoot, "utf8")
        .digest("hex");
      return Object.freeze({
        projectRoot: projectRoot === "" ? "." : projectRoot,
        packageRoot,
        entryUrl,
        version: normalizedVersion,
        declaredRange: declaration.range,
        identity,
      });
    } catch (error) {
      if (error instanceof ProjectPrettierFailureError) throw error;
      /* Try the next hoisted level. */
    }
    if (current === checkoutRoot) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw new ProjectPrettierFailureError({
    code: "PROJECT_PRETTIER_INSTALL_MISSING",
    message: "No installed Prettier satisfying the project declaration was found.",
    projectRoot: projectRoot === "" ? "." : projectRoot,
  });
}

function satisfiesDeclaredRange(
  version: string,
  declaredRange: string,
): boolean {
  const normalizedRange = semver.validRange(declaredRange);
  if (normalizedRange === null) return true;
  try {
    return semver.satisfies(version, normalizedRange);
  } catch {
    return false;
  }
}

interface PendingRequest {
  readonly expectedOperation: "format" | "importConfig";
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

/**
 * Best-effort process-tree termination for cancellation and failure paths.
 * The group may already be gone (leader exit can surface EPERM/ESRCH); the
 * caller's rejection must never be replaced by a cleanup error, and the
 * owned workspace is always disposed afterwards.
 */
async function stopProcessGroupBestEffort(
  pid: number | undefined,
  workerExited: boolean,
): Promise<void> {
  if (pid === undefined || workerExited) return;
  await stopProcessGroup(pid).catch(() => undefined);
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
    !projectPrettierPermitAllows(input.permit, input.checkoutRoot, input.projectRoot)
  ) {
    throw new ProjectPrettierFailureError({
      code: "PROJECT_PRETTIER_TRUST_REQUIRED",
      message: "Project Prettier execution requires explicit trust.",
      projectRoot: input.projectRoot,
    });
  }
  let workspace: ProjectWorkspace;
  try {
    workspace = await createProjectWorkspace(
      {
        repositoryRoot: input.checkoutRoot,
        snapshotRoot: input.snapshotRoot,
        projectRoot: input.projectRoot,
      },
      input.signal,
    );
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
  const failAll = (failure: ProjectPrettierFailure): void => {
    for (const request of pending.values()) {
      request.reject(new ProjectPrettierFailureError(failure));
    }
    pending.clear();
  };

  // Startup cancellation and early worker death must reject the pending
  // `ready` handshake immediately; nothing waits out the startup timer.
  let settleReady: ((error: ProjectPrettierFailure) => void) | undefined;
  const readyAborted = new Promise<void>((_, rejectReady) => {
    settleReady = (failure) => rejectReady(new ProjectPrettierFailureError(failure));
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
    if (id === undefined) return;
    const request = pending.get(id);
    if (request === undefined) return;
    pending.delete(id);
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
        new ProjectPrettierFailureError(
          pendingFailure(
            input.projectRoot,
            "The project formatter did not start in time.",
          ),
        ),
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
    void (async () => {
      try {
        await stopProcessGroupBestEffort(child.pid, workerExited);
      } finally {
        await workspace.dispose().catch(() => undefined);
      }
    })();
  };
  input.signal.addEventListener("abort", abort, { once: true });

  try {
    child.send({
      type: "init",
      installation: { entryUrl: input.installation.entryUrl },
      treeRoot: workspace.treeRoot,
      projectRoot: input.projectRoot,
    } as Serializable);
    await Promise.race([ready, readyAborted]);
  } catch (error) {
    input.signal.removeEventListener("abort", abort);
    await stopProcessGroupBestEffort(child.pid, workerExited);
    await workspace.dispose();
    throw error;
  }

  const request = (
    operation: "format" | "importConfig",
    payload: Record<string, unknown>,
  ): Promise<ProjectPrettierReply> => {
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
      const message = { type: "request", request: { id, operation, ...payload } };
      const serialized = JSON.stringify(message);
      if (Buffer.byteLength(serialized, "utf8") > PROJECT_PROTOCOL_MAX_BYTES * 4) {
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
    async readSharedConfigForImport(
      configPackage: string,
    ): Promise<ImportableNativeConfig> {
      const reply = await request("importConfig", { configPackage });
      if (reply.operation !== "importConfig") throw new Error("Unexpected reply");
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
      const exitedGracefully = await Promise.race([
        exited.then(() => true),
        new Promise<boolean>((resolveRace) =>
          setTimeout(() => resolveRace(false), CLOSE_GRACE_MS),
        ),
      ]);
      if (!exitedGracefully) {
        await stopProcessGroupBestEffort(child.pid, workerExited);
      }
      await workspace.dispose();
    },
  });
}

export async function openProjectFormatter(
  input: ProjectFormatterInput,
): Promise<ProjectFormatterSession> {
  return openSession(input);
}
