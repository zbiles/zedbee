import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isContainedPath } from "../../inspection/read-json.js";
import type {
  ImportableNativeConfig,
  ProjectFormatResult,
  ProjectPrettierFailure,
  ProjectPrettierRequest,
  ProjectPrettierReply,
} from "./project-types.js";
import { parseProjectRequest } from "./project-protocol.js";
import type { FormattingSettings } from "./settings.js";

type PrettierModule = typeof import("prettier");

interface WorkerState {
  readonly treeRoot: string;
  readonly projectRoot: string;
  readonly prettier: PrettierModule;
}

let state: WorkerState | undefined;
let busy = false;

function send(reply: ProjectPrettierReply): void {
  process.send?.({ type: "reply", reply });
}

function failure(
  code: ProjectPrettierFailure["code"],
  message: string,
  file?: string,
): ProjectPrettierFailure {
  return {
    code,
    message,
    projectRoot: state?.projectRoot ?? ".",
    ...(file === undefined ? {} : { file }),
  };
}

function ignorePaths(treeRoot: string, projectRoot: string): readonly string[] {
  const projectDirectory = resolve(treeRoot, projectRoot);
  const candidates = [
    join(projectDirectory, ".prettierignore"),
    join(treeRoot, ".gitignore"),
  ];
  return candidates.filter((path) => existsSync(path));
}

function ignoreReason(treeRoot: string, projectRoot: string): "prettierignore" | "gitignore" {
  const projectDirectory = resolve(treeRoot, projectRoot);
  return existsSync(join(projectDirectory, ".prettierignore"))
    ? "prettierignore"
    : "gitignore";
}

async function resolveOptions(
  file: string,
  prettier: PrettierModule,
  treeRoot: string,
): Promise<import("prettier").Options> {
  const configPath = await prettier.resolveConfigFile(file);
  if (configPath === null || !isContainedPath(treeRoot, configPath)) {
    return {};
  }
  return (await prettier.resolveConfig(file, {
    config: configPath,
    editorconfig: true,
  })) ?? {};
}

async function formatFile(
  request: Extract<ProjectPrettierRequest, { operation: "format" }>,
): Promise<ProjectFormatResult> {
  const current = state!;
  const absolute = resolve(current.treeRoot, request.file);
  if (!isContainedPath(current.treeRoot, absolute)) {
    return { kind: "ignored", reason: "unsupported" };
  }
  const ignorePath = ignorePaths(current.treeRoot, current.projectRoot);
  const info = await current.prettier.getFileInfo(absolute, {
    ignorePath: [...ignorePath],
    withNodeModules: false,
    resolveConfig: false,
  });
  if (info.ignored) {
    return { kind: "ignored", reason: ignoreReason(current.treeRoot, current.projectRoot) };
  }
  if (info.inferredParser === null) {
    return { kind: "ignored", reason: "unsupported" };
  }
  const options = await resolveOptions(absolute, current.prettier, current.treeRoot);
  const text = await current.prettier.format(request.source, {
    ...options,
    filepath: request.file,
  });
  return { kind: "formatted", text };
}

function sanitizeSettings(value: unknown): Partial<FormattingSettings> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (
      typeof entry === "string" ||
      typeof entry === "number" ||
      typeof entry === "boolean"
    ) {
      result[key] = entry;
    }
  }
  return result as Partial<FormattingSettings>;
}

async function importConfig(
  request: Extract<ProjectPrettierRequest, { operation: "importConfig" }>,
): Promise<ImportableNativeConfig> {
  const current = state!;
  const absolute = resolve(current.treeRoot, request.configFile);
  if (!isContainedPath(current.treeRoot, absolute)) {
    throw new Error("Configuration is outside the formatting workspace");
  }
  const limitations: string[] = [];
  const module = (await import(pathToFileURL(absolute).href)) as {
    default?: unknown;
  };
  const exported = module.default;
  if (typeof exported === "function") {
    limitations.push(
      "The exported configuration is a function and its dynamic values cannot be represented.",
    );
    return { settings: {}, overrides: [], limitations };
  }
  const settings = sanitizeSettings(exported);
  const overrides: {
    files: string | readonly string[];
    excludeFiles?: string | readonly string[];
    settings: Partial<FormattingSettings>;
  }[] = [];
  if (
    typeof exported === "object" &&
    exported !== null &&
    Array.isArray((exported as { overrides?: unknown }).overrides)
  ) {
    for (const entry of (exported as { overrides: unknown[] }).overrides) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const files = record.files;
      if (typeof files !== "string" && !Array.isArray(files)) continue;
      const options = record.options;
      overrides.push({
        files: files as string | readonly string[],
        ...(record.excludeFiles === undefined
          ? {}
          : { excludeFiles: record.excludeFiles as string | readonly string[] }),
        settings: sanitizeSettings(options),
      });
    }
  }
  return { settings, overrides, limitations };
}

async function handle(request: ProjectPrettierRequest): Promise<ProjectPrettierReply> {
  try {
    if (request.operation === "format") {
      return { id: request.id, operation: "format", result: await formatFile(request) };
    }
    return {
      id: request.id,
      operation: "importConfig",
      result: await importConfig(request),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Formatter failed";
    const pluginMissing = /plugin|Cannot find module|Cannot find package/iu.test(message);
    return {
      id: request.id,
      operation: "error",
      failure: failure(
        pluginMissing
          ? "PROJECT_PRETTIER_PLUGIN_MISSING"
          : "PROJECT_PRETTIER_WORKER_FAILED",
        pluginMissing
          ? "A configured Prettier plugin could not be loaded."
          : "The project's Prettier could not format the requested file.",
        request.operation === "format" ? request.file : undefined,
      ),
    };
  }
}

process.on("disconnect", () => process.exit(0));
process.on("message", (message: unknown) => {
  void (async () => {
    const input = message as { type?: string } | null;
    if (input?.type === "close") {
      process.exit(0);
      return;
    }
    if (input?.type === "init") {
      const init = message as {
        installation: { entryUrl: string };
        treeRoot: string;
        projectRoot: string;
      };
      const imported = (await import(init.installation.entryUrl)) as {
        default?: PrettierModule;
      } & PrettierModule;
      const prettier =
        typeof imported.format === "function"
          ? imported
          : (imported.default as PrettierModule);
      state = {
        treeRoot: init.treeRoot,
        projectRoot: init.projectRoot,
        prettier,
      };
      process.send?.({ type: "ready" });
      return;
    }
    if (input?.type === "request" && state !== undefined && !busy) {
      busy = true;
      try {
        const request = parseProjectRequest(
          (message as { request: unknown }).request,
        );
        send(await handle(request));
      } catch {
        const raw = (message as { request?: { id?: unknown } }).request;
        const id = typeof raw?.id === "number" ? raw.id : -1;
        send({
          id,
          operation: "error",
          failure: failure(
            "PROJECT_PRETTIER_PROTOCOL_INVALID",
            "The project formatter received an invalid request.",
          ),
        });
      } finally {
        busy = false;
      }
    }
  })();
});
