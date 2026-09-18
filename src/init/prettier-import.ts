import { posix } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import {
  DEFAULT_FORMATTING_SETTINGS,
  formattingSettingsSchema,
  type FormattingSettings,
} from "../checks/prettier/settings.js";
import type { ImportedFormattingOverride } from "../checks/prettier/project-types.js";
import type { SnapshotRegistry } from "../inspection/snapshot-registry.js";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
  readJsonData,
} from "../inspection/read-json.js";
import { captureSnapshotRegistry } from "../inspection/snapshot-registry.js";
import {
  discoverProjectPrettier,
  type ProjectPrettierDiscovery,
} from "./prettier-discovery.js";

const CONFIG_MAX_BYTES = 1024 * 1024;
const SUPPORTED_OPTION_KEYS = new Set(Object.keys(DEFAULT_FORMATTING_SETTINGS));
const SUPPORTED_SETTINGS_SCHEMA = formattingSettingsSchema.partial();

/** Prettier configuration precedence; first existing file wins in each project. */
const CONFIG_PRECEDENCE = [
  "package.json",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.json5",
  ".prettierrc.js",
  ".prettierrc.cjs",
  "prettier.config.js",
  "prettier.config.cjs",
  ".prettierrc.mjs",
  "prettier.config.mjs",
  ".prettierrc.ts",
  "prettier.config.ts",
  ".prettierrc.toml",
] as const;

const EXECUTABLE_EXTENSIONS = new Set([
  ".js",
  ".cjs",
  ".mjs",
  ".ts",
  ".cts",
  ".mts",
]);

export interface PrettierSettingsImportPreview {
  readonly settings: Partial<FormattingSettings>;
  readonly overrides: readonly ImportedFormattingOverride[];
  readonly limitations: readonly string[];
}

interface ParsedConfigData {
  readonly settings: Partial<FormattingSettings>;
  readonly overrides: readonly ImportedFormattingOverride[];
  readonly limitations: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readConfigValue(
  registry: SnapshotRegistry,
  repositoryPath: string,
): Promise<unknown> {
  const contents = await readContainedFile(registry, repositoryPath, {
    maxBytes: CONFIG_MAX_BYTES,
  });
  const extension = posix.extname(repositoryPath);
  if (extension === ".json5") return JSON5.parse(contents) as unknown;
  if (extension === ".toml") return parseToml(contents) as unknown;
  if (extension === ".yaml" || extension === ".yml") {
    return parseYaml(contents) as unknown;
  }
  if (extension === ".json") return JSON.parse(contents) as unknown;
  // `.prettierrc` without an extension is JSON or YAML.
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    return parseYaml(contents) as unknown;
  }
}

function patternList(value: unknown): readonly string[] | undefined {
  if (typeof value === "string") return Object.freeze([value]);
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return Object.freeze([...value]);
  }
  return undefined;
}

function supportedSettings(
  value: unknown,
  limitations: string[],
  context: string,
): Partial<FormattingSettings> {
  if (!isRecord(value)) {
    limitations.push(`${context} settings are not a plain object.`);
    return {};
  }
  const candidate: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    if (!SUPPORTED_OPTION_KEYS.has(key)) {
      limitations.push(`${context} option "${key}" is not a managed setting.`);
      continue;
    }
    candidate[key] = value[key];
  }
  const parsed = SUPPORTED_SETTINGS_SCHEMA.safeParse(candidate);
  if (!parsed.success) {
    for (const key of Object.keys(candidate)) {
      const single = SUPPORTED_SETTINGS_SCHEMA.safeParse({
        [key]: candidate[key],
      });
      if (!single.success) {
        limitations.push(`${context} option "${key}" has an unsupported value.`);
        delete candidate[key];
      }
    }
    return candidate as unknown as Partial<FormattingSettings>;
  }
  return parsed.data as unknown as Partial<FormattingSettings>;
}

function parseOverrides(
  value: unknown,
  limitations: string[],
  prefix: string,
): readonly ImportedFormattingOverride[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    limitations.push("Prettier overrides are not an array and were not copied.");
    return [];
  }
  const overrides: ImportedFormattingOverride[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      limitations.push("A Prettier override entry is not a plain object.");
      continue;
    }
    const files = patternList(entry.files);
    if (files === undefined || files.length === 0) {
      limitations.push("A Prettier override entry has no usable files pattern.");
      continue;
    }
    const excludeFiles = patternList(entry.excludeFiles) ?? [];
    const settings = supportedSettings(
      entry.options,
      limitations,
      "Prettier override",
    );
    overrides.push(
      Object.freeze({
        files: Object.freeze(
          files.map((file) => (prefix === "" ? file : posix.join(prefix, file))),
        ),
        excludeFiles,
        settings,
      }),
    );
  }
  return Object.freeze(overrides);
}

function classifyConfigValue(
  value: unknown,
  executable: boolean,
  limitations: string[],
  prefix: string,
): ParsedConfigData {
  if (executable) {
    limitations.push(
      "This project uses an executable or shared Prettier configuration; its dynamic values cannot be copied as inert settings.",
    );
    return { settings: {}, overrides: [], limitations };
  }
  if (!isRecord(value)) {
    limitations.push("The Prettier configuration is not a plain object.");
    return { settings: {}, overrides: [], limitations };
  }

  const optionValues: Record<string, unknown> = {};
  for (const key of Object.keys(value)) {
    if (key === "overrides" || key === "$schema") continue;
    if (key === "plugins") {
      limitations.push(
        "Configured Prettier plugins cannot be copied into managed settings.",
      );
      continue;
    }
    if (!SUPPORTED_OPTION_KEYS.has(key)) {
      limitations.push(`Prettier option "${key}" is not a managed setting.`);
      continue;
    }
    optionValues[key] = value[key];
  }
  const settings = supportedSettings(
    optionValues,
    limitations,
    "Prettier",
  );
  const overrides = parseOverrides(value.overrides, limitations, prefix);
  return { settings, overrides, limitations };
}

async function selectedConfigPath(
  registry: SnapshotRegistry,
  projectRoot: string,
  configPaths: readonly string[],
): Promise<string | undefined> {
  const available = new Set(configPaths);
  for (const name of CONFIG_PRECEDENCE) {
    if (name === "package.json") {
      const manifestPath =
        projectRoot === "." ? "package.json" : posix.join(projectRoot, name);
      if (registry.resolve(manifestPath)?.targetKind === "file") {
        const manifest = await readJsonData(registry, manifestPath);
        if (isRecord(manifest) && manifest.prettier !== undefined) {
          return manifestPath;
        }
      }
      continue;
    }
    const path = projectRoot === "." ? name : posix.join(projectRoot, name);
    if (available.has(path)) return path;
  }
  return undefined;
}

async function loadProjectConfig(
  registry: SnapshotRegistry,
  discovery: ProjectPrettierDiscovery,
): Promise<ParsedConfigData & { readonly configPath?: string }> {
  const configPath = await selectedConfigPath(
    registry,
    discovery.projectRoot,
    discovery.configPaths,
  );
  if (configPath === undefined) {
    return { settings: {}, overrides: [], limitations: [] };
  }
  const limitations: string[] = [];
  const executable =
    discovery.executableConfig &&
    (configPath === "package.json" ||
      EXECUTABLE_EXTENSIONS.has(posix.extname(configPath)));
  if (executable) {
    limitations.push(
      "This project uses an executable or shared Prettier configuration; its dynamic values cannot be copied as inert settings.",
    );
    return { settings: {}, overrides: [], limitations, configPath };
  }
  let value: unknown;
  if (posix.basename(configPath) === "package.json") {
    const manifest = await readJsonData(registry, configPath);
    value = isRecord(manifest) ? manifest.prettier : undefined;
    if (typeof value === "string") {
      limitations.push(
        "The package.json prettier field references a shared configuration that cannot be copied as inert settings.",
      );
      return { settings: {}, overrides: [], limitations, configPath };
    }
  } else {
    try {
      value = await readConfigValue(registry, configPath);
    } catch {
      limitations.push(
        `The Prettier configuration ${configPath} could not be parsed as data.`,
      );
      return { settings: {}, overrides: [], limitations, configPath };
    }
  }
  const prefix = discovery.projectRoot === "." ? "" : discovery.projectRoot;
  return {
    ...classifyConfigValue(value, false, limitations, prefix),
    configPath,
  };
}

function ignoreFileLimitations(
  registry: SnapshotRegistry,
  projectRoot: string,
  limitations: string[],
): void {
  for (const name of [".prettierignore", ".gitignore"]) {
    const path = projectRoot === "." ? name : posix.join(projectRoot, name);
    if (registry.resolve(path)?.targetKind === "file") {
      limitations.push(
        `${name} is not copied; use project mode or existing formatting-only exclusions for ignored paths.`,
      );
    }
  }
}

export async function previewPrettierSettingsImport(
  repositoryRoot: string,
): Promise<PrettierSettingsImportPreview> {
  let canonicalRoot: string;
  try {
    canonicalRoot = await canonicalizeSnapshotRoot(repositoryRoot);
  } catch {
    return { settings: {}, overrides: [], limitations: [] };
  }
  const registry = await captureSnapshotRegistry(canonicalRoot);
  const discoveries = await discoverProjectPrettier(repositoryRoot);

  const limitations: string[] = [];
  const rootDiscovery = discoveries.find(
    (discovery) => discovery.projectRoot === ".",
  );
  const selected =
    rootDiscovery ??
    discoveries.find((discovery) => discovery.configPaths.length > 0);

  let settings: Partial<FormattingSettings> = {};
  let overrides: readonly ImportedFormattingOverride[] = [];
  if (selected !== undefined) {
    const loaded = await loadProjectConfig(registry, selected);
    settings = loaded.settings;
    overrides = loaded.overrides;
    limitations.push(...loaded.limitations);
    ignoreFileLimitations(registry, selected.projectRoot, limitations);
  }

  const nestedOverrides: ImportedFormattingOverride[] = [];
  for (const discovery of discoveries) {
    if (discovery.projectRoot === "." || discovery === selected) continue;
    if (discovery.configPaths.length === 0) continue;
    const loaded = await loadProjectConfig(registry, discovery);
    limitations.push(...loaded.limitations);
    if (
      Object.keys(loaded.settings).length === 0 &&
      loaded.overrides.length === 0
    ) {
      continue;
    }
    nestedOverrides.push(
      Object.freeze({
        files: Object.freeze([`${discovery.projectRoot}/**`]),
        excludeFiles: Object.freeze([]),
        settings: Object.freeze({
          ...DEFAULT_FORMATTING_SETTINGS,
          ...loaded.settings,
        }),
      }),
    );
    nestedOverrides.push(...loaded.overrides);
  }

  return {
    settings,
    overrides: Object.freeze([...overrides, ...nestedOverrides]),
    limitations: Object.freeze([...new Set(limitations)]),
  };
}
