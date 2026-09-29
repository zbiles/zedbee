import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { isContainedPath } from "../../inspection/read-json.js";
import type {
  ImportableNativeConfig,
  ProjectFormatSupport,
  ProjectFormatResult,
  ProjectPrettierFailure,
  ProjectPrettierRequest,
  ProjectPrettierReply,
} from "./project-types.js";
import { parseProjectRequest } from "./project-protocol.js";
import {
  formattingSettingsSchema,
  type FormattingSettings,
} from "./settings.js";

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

async function ignoreReason(
  file: string,
): Promise<"prettierignore" | "gitignore"> {
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

async function resolveOptions(
  file: string,
  prettier: PrettierModule,
  treeRoot: string,
): Promise<import("prettier").Options> {
  const configPath = await prettier.resolveConfigFile(file);
  if (configPath === null) {
    // Keep native EditorConfig matching, bounded by the owned parent root.
    return (
      (await prettier.resolveConfig(file, {
        config: join(dirname(treeRoot), "empty-prettier-config.json"),
        editorconfig: true,
      })) ?? {}
    );
  }
  if (!isContainedPath(treeRoot, configPath)) {
    // A resolved path outside the mirror must never be executed; reporting
    // defaults as if the project chose them would be a silent fallback.
    throw new WorkerConfigError(
      "PROJECT_PRETTIER_CONFIG_INVALID",
      "The resolved Prettier configuration is outside the selected snapshot.",
    );
  }
  return (
    (await prettier.resolveConfig(file, {
      config: configPath,
      editorconfig: true,
    })) ?? {}
  );
}

interface SupportedFile {
  readonly kind: "supported";
  readonly options: import("prettier").Options;
}

type ClassifiedFile =
  SupportedFile | Exclude<ProjectFormatSupport, { kind: "supported" }>;

const classificationCache = new Map<string, SupportedFile>();
const CLASSIFICATION_CACHE_MAX_ENTRIES = 128;

function rememberClassification(file: string, result: SupportedFile): void {
  if (classificationCache.size >= CLASSIFICATION_CACHE_MAX_ENTRIES) {
    const oldest = classificationCache.keys().next().value as
      string | undefined;
    if (oldest !== undefined) classificationCache.delete(oldest);
  }
  classificationCache.set(file, result);
}

async function classifyFile(file: string): Promise<ClassifiedFile> {
  const current = state!;
  const absolute = resolve(current.treeRoot, file);
  if (!isContainedPath(current.treeRoot, absolute)) {
    return { kind: "ignored", reason: "unsupported" };
  }
  if (
    await fileInfoIgnoredBy(current.prettier, absolute, projectIgnorePaths())
  ) {
    return { kind: "ignored", reason: await ignoreReason(absolute) };
  }
  const options = await resolveOptions(
    absolute,
    current.prettier,
    current.treeRoot,
  );
  // Parser inference must see the project's own plugins; otherwise a file
  // supported only through a plugin would be reported as unsupported.
  const supported = await current.prettier.getFileInfo(absolute, {
    withNodeModules: false,
    resolveConfig: false,
    plugins: (options.plugins as string[] | undefined) ?? [],
  });
  if (supported.inferredParser === null && typeof options.parser !== "string") {
    return { kind: "ignored", reason: "unsupported" };
  }
  return { kind: "supported", options };
}

async function formatFile(
  request: Extract<ProjectPrettierRequest, { operation: "format" }>,
): Promise<ProjectFormatResult> {
  const current = state!;
  const cached = classificationCache.get(request.file);
  classificationCache.delete(request.file);
  const classified = cached ?? (await classifyFile(request.file));
  if (classified.kind === "ignored") return classified;
  const text = await current.prettier.format(request.source, {
    ...classified.options,
    filepath: resolve(current.treeRoot, request.file),
  });
  return { kind: "formatted", text };
}

const SUPPORTED_SETTINGS_KEYS: ReadonlySet<string> = new Set(
  Object.keys(formattingSettingsSchema.shape),
);
const SUPPORTED_SETTINGS_SCHEMA = formattingSettingsSchema.partial().strict();

/**
 * Copies only supported plain data values. Own data descriptors are read
 * directly — accessors are never invoked — and every dropped plugin, key, or
 * value is reported as a visible limitation instead of disappearing.
 */
function sanitizeSettings(
  value: unknown,
  limitations: string[],
  context: string,
): Partial<FormattingSettings> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    limitations.push(
      `The ${context} is not a plain object and was not copied.`,
    );
    return {};
  }
  const result: Record<string, unknown> = {};
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") continue;
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (
      descriptor === undefined ||
      descriptor.enumerable !== true ||
      !("value" in descriptor)
    ) {
      limitations.push(
        `The ${context} property "${key}" is an accessor or non-data value and was not copied.`,
      );
      continue;
    }
    const entry = descriptor.value;
    // Overrides are sanitized separately below. Treating this known metadata
    // key as a dynamic formatting value produces a false limitation even
    // when every override is representable.
    if (key === "overrides") continue;
    if (key === "plugins") {
      if (!Array.isArray(entry) || entry.length > 0) {
        limitations.push(
          "Configured Prettier plugins cannot be copied into managed settings.",
        );
      }
      continue;
    }
    if (
      typeof entry === "function" ||
      (typeof entry === "object" && entry !== null)
    ) {
      limitations.push(
        `The ${context} option "${key}" is a dynamic value and was not copied.`,
      );
      continue;
    }
    if (!SUPPORTED_SETTINGS_KEYS.has(key)) {
      limitations.push(
        `The ${context} option "${key}" is not a managed setting and was not copied.`,
      );
      continue;
    }
    const single = SUPPORTED_SETTINGS_SCHEMA.safeParse({ [key]: entry });
    if (!single.success) {
      limitations.push(
        `The ${context} option "${key}" has an unsupported value and was not copied.`,
      );
      continue;
    }
    result[key] = entry;
  }
  return result as Partial<FormattingSettings>;
}

function sanitizeOverrideEntry(
  entry: unknown,
  limitations: string[],
):
  | {
      files: string | readonly string[];
      excludeFiles?: string | readonly string[];
      settings: Partial<FormattingSettings>;
    }
  | undefined {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    limitations.push(
      "An exported configuration override is not a plain object and was not copied.",
    );
    return undefined;
  }
  const filesDescriptor = Object.getOwnPropertyDescriptor(entry, "files");
  const files =
    filesDescriptor !== undefined && "value" in filesDescriptor
      ? filesDescriptor.value
      : undefined;
  const hasFiles =
    typeof files === "string" ||
    (Array.isArray(files) &&
      files.every((item) => typeof item === "string" && item.length > 0));
  if (!hasFiles || files === undefined) {
    limitations.push(
      "An exported configuration override has no usable files pattern and was not copied.",
    );
    return undefined;
  }
  const excludeDescriptor = Object.getOwnPropertyDescriptor(
    entry,
    "excludeFiles",
  );
  const excludeFiles =
    excludeDescriptor !== undefined && "value" in excludeDescriptor
      ? excludeDescriptor.value
      : undefined;
  if (excludeFiles !== undefined) {
    limitations.push(
      "Prettier excludeFiles cannot be copied exactly; the override keeps its files patterns without the exclusions.",
    );
  }
  const optionsDescriptor = Object.getOwnPropertyDescriptor(entry, "options");
  const settings = sanitizeSettings(
    optionsDescriptor !== undefined && "value" in optionsDescriptor
      ? optionsDescriptor.value
      : undefined,
    limitations,
    "override",
  );
  if (Object.keys(settings).length === 0) {
    limitations.push(
      "An exported configuration override has no supported settings and was not copied.",
    );
    return undefined;
  }
  return {
    files: files as string | readonly string[],
    settings,
  };
}

async function importConfig(
  request: Extract<ProjectPrettierRequest, { operation: "importConfig" }>,
): Promise<ImportableNativeConfig> {
  const current = state!;
  const limitations: string[] = [];
  let module: { default?: unknown };
  if ("configPackage" in request) {
    // A package-exported shared configuration resolves through the project's
    // approved installed dependencies inside the mirror, then executes once
    // under this consented evaluation.
    const require = createRequire(
      join(current.treeRoot, current.projectRoot, "package.json"),
    );
    const resolved = require.resolve(request.configPackage);
    module = (await import(pathToFileURL(resolved).href)) as {
      default?: unknown;
    };
  } else {
    const absolute = resolve(current.treeRoot, request.configFile);
    if (!isContainedPath(current.treeRoot, absolute)) {
      throw new Error("Configuration is outside the formatting workspace");
    }
    module = (await import(pathToFileURL(absolute).href)) as {
      default?: unknown;
    };
  }
  const exported = module.default;
  if (typeof exported === "function") {
    limitations.push(
      "The exported configuration is a function and its dynamic values cannot be represented.",
    );
    return { settings: {}, overrides: [], limitations };
  }
  if (
    typeof exported !== "object" ||
    exported === null ||
    Array.isArray(exported)
  ) {
    limitations.push(
      "The exported configuration is not a plain object and cannot be represented.",
    );
    return { settings: {}, overrides: [], limitations };
  }
  const settings = sanitizeSettings(exported, limitations, "configuration");
  const overrides: {
    files: string | readonly string[];
    settings: Partial<FormattingSettings>;
  }[] = [];
  const overridesDescriptor = Object.getOwnPropertyDescriptor(
    exported,
    "overrides",
  );
  const overridesValue =
    overridesDescriptor !== undefined && "value" in overridesDescriptor
      ? overridesDescriptor.value
      : undefined;
  if (overridesValue !== undefined && !Array.isArray(overridesValue)) {
    limitations.push(
      "The exported overrides value is not an array and was not copied.",
    );
  }
  if (Array.isArray(overridesValue)) {
    for (const entry of overridesValue) {
      const sanitized = sanitizeOverrideEntry(entry, limitations);
      if (sanitized !== undefined) overrides.push(sanitized);
    }
  }
  return { settings, overrides, limitations };
}

async function handle(
  request: ProjectPrettierRequest,
): Promise<ProjectPrettierReply> {
  try {
    if (request.operation === "classify") {
      const classified = await classifyFile(request.file);
      if (classified.kind === "supported") {
        rememberClassification(request.file, classified);
        return {
          id: request.id,
          operation: "classify",
          result: { kind: "supported" },
        };
      }
      return {
        id: request.id,
        operation: "classify",
        result: classified,
      };
    }
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
        request.operation === "format" || request.operation === "classify"
          ? request.file
          : undefined,
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
