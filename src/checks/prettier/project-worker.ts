import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, posix, resolve } from "node:path";
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

/** Carries a structured formatter failure out of the request handlers. */
class WorkerConfigError extends Error {
  constructor(
    readonly code: "PROJECT_PRETTIER_CONFIG_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "WorkerConfigError";
  }
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

function projectDirectory(): string {
  return resolve(state!.treeRoot, state!.projectRoot);
}

/** Explicit project-root ignore files only; other projects' files are not read. */
function projectIgnorePaths(): readonly string[] {
  const directory = projectDirectory();
  const candidates = [
    join(directory, ".prettierignore"),
    join(directory, ".gitignore"),
  ];
  return candidates.filter((path) => existsSync(path));
}

async function fileInfoIgnoredBy(
  prettier: PrettierModule,
  file: string,
  ignorePaths: readonly string[],
): Promise<boolean> {
  if (ignorePaths.length === 0) return false;
  const info = await prettier.getFileInfo(file, {
    ignorePath: [...ignorePaths],
    withNodeModules: false,
    resolveConfig: false,
  });
  return info.ignored === true;
}

async function ignoreReason(file: string): Promise<"prettierignore" | "gitignore"> {
  const directory = projectDirectory();
  const prettierIgnore = join(directory, ".prettierignore");
  const gitIgnore = join(directory, ".gitignore");
  if (existsSync(prettierIgnore)) {
    if (await fileInfoIgnoredBy(state!.prettier, file, [prettierIgnore])) {
      return "prettierignore";
    }
  }
  if (existsSync(gitIgnore)) {
    if (await fileInfoIgnoredBy(state!.prettier, file, [gitIgnore])) {
      return "gitignore";
    }
  }
  return "prettierignore";
}

interface BoundedEditorConfig {
  readonly root: boolean;
  readonly settings: Partial<FormattingSettings>;
}

function parseEditorConfig(contents: string): BoundedEditorConfig {
  let root = false;
  const settings: Partial<FormattingSettings> = {};
  let appliesToAll = false;
  for (const rawLine of contents.split(/\r?\n|\r/u)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#") || line.startsWith(";")) continue;
    if (line.startsWith("[") && line.endsWith("]")) {
      const section = line.slice(1, -1).trim();
      appliesToAll = section === "*" || section === "*.*";
      continue;
    }
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "root") {
      if (value.toLowerCase() === "true") root = true;
      continue;
    }
    if (!appliesToAll) continue;
    if (key === "indent_style") {
      if (value === "tab") settings.useTabs = true;
      else if (value === "space") settings.useTabs = false;
    } else if (key === "indent_size" || key === "max_line_length") {
      const parsed = Number(value);
      if (Number.isSafeInteger(parsed) && parsed > 0) {
        if (key === "indent_size") settings.tabWidth = parsed;
        else settings.printWidth = parsed;
      }
    } else if (key === "end_of_line") {
      if (value === "lf" || value === "crlf" || value === "cr") {
        settings.endOfLine = value;
      }
    }
  }
  return { root, settings };
}

const EDITORCONFIG_MAX_BYTES = 256 * 1024;

/** Data-only EditorConfig values for a file, bounded to the mirror. */
async function editorConfigOptions(
  file: string,
): Promise<Partial<FormattingSettings>> {
  const treeRoot = state!.treeRoot;
  const settings: Partial<FormattingSettings> = {};
  const chain: string[] = [];
  let directory = dirname(file);
  while (isContainedPath(treeRoot, directory)) {
    chain.unshift(directory);
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  const collected: Partial<FormattingSettings>[] = [];
  for (const entry of [...chain].reverse()) {
    const configPath = join(entry, ".editorconfig");
    if (!existsSync(configPath)) continue;
    let contents: string;
    try {
      const metadata = await lstat(configPath);
      if (!metadata.isFile() || metadata.size > BigInt(EDITORCONFIG_MAX_BYTES)) {
        continue;
      }
      contents = await readFile(configPath, "utf8");
    } catch {
      continue;
    }
    const parsed = parseEditorConfig(contents);
    collected.unshift(parsed.settings);
    if (parsed.root) break;
  }
  for (const entry of collected) {
    Object.assign(settings, entry);
  }
  return settings;
}

async function resolveOptions(
  file: string,
  prettier: PrettierModule,
  treeRoot: string,
): Promise<import("prettier").Options> {
  const configPath = await prettier.resolveConfigFile(file);
  if (configPath === null) {
    // No Prettier configuration exists; EditorConfig still applies through a
    // bounded data-only reader instead of an unbounded implicit search.
    return (await editorConfigOptions(file)) as import("prettier").Options;
  }
  if (!isContainedPath(treeRoot, configPath)) {
    // A resolved path outside the mirror must never be executed; reporting
    // defaults as if the project chose them would be a silent fallback.
    throw new WorkerConfigError(
      "PROJECT_PRETTIER_CONFIG_INVALID",
      "The resolved Prettier configuration is outside the selected snapshot.",
    );
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
  if (await fileInfoIgnoredBy(current.prettier, absolute, projectIgnorePaths())) {
    return { kind: "ignored", reason: await ignoreReason(absolute) };
  }
  const options = await resolveOptions(absolute, current.prettier, current.treeRoot);
  // Parser inference must see the project's own plugins; otherwise a file
  // supported only through a plugin would be reported as unsupported.
  const supported = await current.prettier.getFileInfo(absolute, {
    withNodeModules: false,
    resolveConfig: false,
    plugins: (options.plugins as string[] | undefined) ?? [],
  });
  if (supported.inferredParser === null) {
    return { kind: "ignored", reason: "unsupported" };
  }
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

async function handle(
  request: ProjectPrettierRequest,
): Promise<ProjectPrettierReply> {
  try {
    if (request.operation === "format") {
      return {
        id: request.id,
        operation: "format",
        result: await formatFile(request),
      };
    }
    return {
      id: request.id,
      operation: "importConfig",
      result: await importConfig(request),
    };
  } catch (error) {
    if (error instanceof WorkerConfigError) {
      return {
        id: request.id,
        operation: "error",
        failure: failure(error.code, error.message),
      };
    }
    const message = error instanceof Error ? error.message : "Formatter failed";
    const pluginMissing =
      /plugin|Cannot find module|Cannot find package/iu.test(message);
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
