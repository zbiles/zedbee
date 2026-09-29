import { posix } from "node:path";
import JSON5 from "json5";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import semver from "semver";
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
import { editorConfigImport } from "./prettier-editorconfig.js";

const CONFIG_MAX_BYTES = 1024 * 1024;
const SUPPORTED_OPTION_KEYS = new Set(Object.keys(DEFAULT_FORMATTING_SETTINGS));
const SUPPORTED_SETTINGS_SCHEMA = formattingSettingsSchema.partial();

/** Prettier configuration precedence; first existing file wins in each project. */
const LEGACY_CONFIG_PRECEDENCE = [
  "package.json",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.json5",
  ".prettierrc.js",
  ".prettierrc.mjs",
  ".prettierrc.cjs",
  "prettier.config.js",
  "prettier.config.mjs",
  "prettier.config.cjs",
  ".prettierrc.toml",
] as const;

const MODERN_CONFIG_PRECEDENCE = [
  "package.json",
  "package.yaml",
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yml",
  ".prettierrc.yaml",
  ".prettierrc.json5",
  ".prettierrc.js",
  "prettier.config.js",
  ".prettierrc.ts",
  "prettier.config.ts",
  ".prettierrc.mjs",
  "prettier.config.mjs",
  ".prettierrc.mts",
  "prettier.config.mts",
  ".prettierrc.cjs",
  "prettier.config.cjs",
  ".prettierrc.cts",
  "prettier.config.cts",
  ".prettierrc.toml",
] as const;

const PACKAGE_YAML_CONFIG_PRECEDENCE = [
  "package.json",
  "package.yaml",
  ...LEGACY_CONFIG_PRECEDENCE.slice(1),
] as const;

function configPrecedence(version: string): readonly string[] {
  if (semver.gte(version, "3.5.0")) return MODERN_CONFIG_PRECEDENCE;
  if (semver.gte(version, "3.3.0"))
    return PACKAGE_YAML_CONFIG_PRECEDENCE;
  return LEGACY_CONFIG_PRECEDENCE;
}

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
  readonly executableConfigs: readonly {
    readonly projectRoot: string;
    readonly configPath: string;
  }[];
  readonly sharedConfigs: readonly {
    readonly projectRoot: string;
    readonly configPath: string;
    readonly specifier: string;
  }[];
}

interface ParsedConfigData {
  readonly settings: Partial<FormattingSettings>;
  readonly overrides: readonly ImportedFormattingOverride[];
  readonly limitations: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function readPackagePrettierValue(
  registry: SnapshotRegistry,
  path: string,
): Promise<unknown> {
  const manifest = posix.basename(path) === "package.json"
    ? await readJsonData(registry, path)
    : parseYaml(
        await readContainedFile(registry, path, {
          maxBytes: CONFIG_MAX_BYTES,
        }),
      );
  return isRecord(manifest) ? manifest.prettier : undefined;
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

function scopedPattern(prefix: string, pattern: string): string {
  const relative = pattern.includes("/") ? pattern : `**/${pattern}`;
  return prefix === "" || prefix === "."
    ? relative
    : posix.join(prefix, relative);
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
        limitations.push(
          `${context} option "${key}" has an unsupported value.`,
        );
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
    limitations.push(
      "Prettier overrides are not an array and were not copied.",
    );
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
      limitations.push(
        "A Prettier override entry has no usable files pattern.",
      );
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
        files: Object.freeze(files.map((file) => scopedPattern(prefix, file))),
        excludeFiles: Object.freeze(
          excludeFiles.map((file) => scopedPattern(prefix, file)),
        ),
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
  const settings = supportedSettings(optionValues, limitations, "Prettier");
  const overrides = parseOverrides(value.overrides, limitations, prefix);
  return { settings, overrides, limitations };
}

async function selectedConfigPaths(
  registry: SnapshotRegistry,
  discovery: ProjectPrettierDiscovery,
  limitations: string[],
): Promise<readonly string[]> {
  const available = new Set(discovery.configPaths);
  const directories = new Set(
    discovery.configPaths.map((path) => {
      const directory = posix.dirname(path);
      return directory === "" ? "." : directory;
    }),
  );
  directories.add(discovery.projectRoot);
  const selected: string[] = [];
  for (const directory of [...directories].sort((left, right) => {
    const depth = left.split("/").length - right.split("/").length;
    return depth === 0 ? left.localeCompare(right) : depth;
  })) {
    const select = async (
      precedence: readonly string[],
    ): Promise<string | undefined> => {
      for (const name of precedence) {
      const path = directory === "." ? name : posix.join(directory, name);
      if (name === "package.json" || name === "package.yaml") {
        if (name === "package.json" && directory !== discovery.projectRoot)
          continue;
        if (registry.resolve(path)?.targetKind === "file") {
          try {
            if ((await readPackagePrettierValue(registry, path)) !== undefined)
              return path;
          } catch {
            // Native search skips package manifests it cannot parse.
          }
        }
      } else if (available.has(path)) return path;
      }
      return undefined;
    };
    const exactDeclaredVersion = semver.valid(discovery.declaredRange ?? "");
    const knownVersion = discovery.version ?? exactDeclaredVersion ?? undefined;
    if (knownVersion !== undefined) {
      const path = await select(configPrecedence(knownVersion));
      if (path !== undefined) selected.push(path);
      continue;
    }
    const candidates = new Set(
      await Promise.all([
        select(LEGACY_CONFIG_PRECEDENCE),
        select(PACKAGE_YAML_CONFIG_PRECEDENCE),
        select(MODERN_CONFIG_PRECEDENCE),
      ]),
    );
    if (candidates.size > 1) {
      limitations.push(
        `Prettier configuration precedence in ${directory} cannot be determined until the declared formatter version is installed.`,
      );
      continue;
    }
    const path = [...candidates][0];
    if (path !== undefined) selected.push(path);
  }
  return Object.freeze(selected);
}

async function loadProjectConfig(
  registry: SnapshotRegistry,
  configPath: string,
  editorScope?: string,
): Promise<
  ParsedConfigData & {
    readonly configPath: string;
    readonly configRoot: string;
  }
> {
  const configRoot =
    posix.dirname(configPath) === "" ? "." : posix.dirname(configPath);
  const limitations: string[] = [];
  const executable = EXECUTABLE_EXTENSIONS.has(posix.extname(configPath));
  if (executable) {
    limitations.push(
      "This project uses an executable or shared Prettier configuration; its dynamic values cannot be copied as inert settings.",
    );
    return { settings: {}, overrides: [], limitations, configPath, configRoot };
  }
  let value: unknown;
  if (["package.json", "package.yaml"].includes(posix.basename(configPath))) {
    value = await readPackagePrettierValue(registry, configPath);
    if (typeof value === "string") {
      limitations.push(
        `The ${posix.basename(configPath)} Prettier field in ${configPath} references a shared configuration that cannot be copied as inert settings.`,
      );
      return {
        settings: {},
        overrides: [],
        limitations,
        configPath,
        configRoot,
      };
    }
  } else {
    try {
      value = await readConfigValue(registry, configPath);
    } catch {
      limitations.push(
        `The Prettier configuration ${configPath} could not be parsed as data.`,
      );
      return {
        settings: {},
        overrides: [],
        limitations,
        configPath,
        configRoot,
      };
    }
  }
  const prefix = configRoot === "." ? "" : configRoot;
  const classified = classifyConfigValue(value, false, limitations, prefix);
  // Prettier configuration files win over applicable .editorconfig values;
  // the data-only copy therefore fills only the keys the configuration omits.
  const editorConfig = await editorConfigImport(
    registry,
    editorScope ?? configRoot,
  );
  limitations.push(...editorConfig.limitations);
  const settings = { ...editorConfig.settings, ...classified.settings };
  const editorOverrides = editorConfig.overrides.map((override) => ({
    ...override,
    settings: Object.freeze(
      Object.fromEntries(
        Object.entries(override.settings).filter(
          ([key]) => !(key in classified.settings),
        ),
      ),
    ) as Partial<FormattingSettings>,
  }));
  return {
    ...classified,
    settings,
    overrides: Object.freeze([...editorOverrides, ...classified.overrides]),
    configPath,
    configRoot,
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
        `${path} is not copied; use project mode or existing formatting-only exclusions for ignored paths.`,
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
    return {
      settings: {},
      overrides: [],
      limitations: [],
      executableConfigs: [],
      sharedConfigs: [],
    };
  }
  const registry = await captureSnapshotRegistry(canonicalRoot);
  const discoveries = await discoverProjectPrettier(repositoryRoot);

  const limitations: string[] = [];
  let settings: Partial<FormattingSettings> = {};
  const overrides: ImportedFormattingOverride[] = [];
  const configs = new Map<string, string>();
  const executableConfigs: {
    readonly projectRoot: string;
    readonly configPath: string;
  }[] = [];
  const sharedConfigs: {
    readonly projectRoot: string;
    readonly configPath: string;
    readonly specifier: string;
  }[] = [];
  for (const discovery of discoveries) {
    for (const path of await selectedConfigPaths(
      registry,
      discovery,
      limitations,
    )) {
      configs.set(posix.dirname(path), path);
      if (EXECUTABLE_EXTENSIONS.has(posix.extname(path))) {
        executableConfigs.push({
          projectRoot: discovery.projectRoot,
          configPath: path,
        });
      } else if (
        ["package.json", "package.yaml"].includes(posix.basename(path))
      ) {
        const value = await readPackagePrettierValue(registry, path);
        if (typeof value === "string")
          sharedConfigs.push({
            projectRoot: discovery.projectRoot,
            configPath: path,
            specifier: value,
          });
      }
    }
    ignoreFileLimitations(registry, discovery.projectRoot, limitations);
  }
  const scopes = new Set(configs.keys());
  for (const entry of registry.entries()) {
    if (
      posix.basename(entry.repositoryPath) === ".editorconfig" &&
      entry.targetKind === "file"
    )
      scopes.add(posix.dirname(entry.repositoryPath));
  }
  const ordered = [...scopes].sort(
    (a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b),
  );
  for (const scope of ordered) {
    let owner = scope;
    while (!configs.has(owner) && owner !== ".") owner = posix.dirname(owner);
    const path = configs.get(owner);
    const editor =
      path === undefined
        ? await editorConfigImport(registry, scope)
        : undefined;
    const loaded =
      path === undefined
        ? {
            settings: editor!.settings,
            overrides: editor!.overrides,
            limitations: editor!.limitations,
          }
        : await loadProjectConfig(registry, path, scope);
    limitations.push(...loaded.limitations);
    if (scope === ".") settings = loaded.settings;
    else
      overrides.push(
        Object.freeze({
          files: Object.freeze([`${scope}/**`]),
          excludeFiles: Object.freeze([]),
          settings: Object.freeze({
            ...DEFAULT_FORMATTING_SETTINGS,
            ...loaded.settings,
          }),
        }),
      );
    for (const override of loaded.overrides) {
      const files: string[] = [];
      for (const pattern of override.files) {
        if (scope === "." || pattern.startsWith(`${scope}/`))
          files.push(pattern);
        else if (pattern.startsWith("**/")) files.push(`${scope}/${pattern}`);
        else {
          limitations.push(
            `Prettier pattern ${pattern} cannot be copied into EditorConfig scope ${scope} exactly.`,
          );
        }
      }
      if (files.length)
        overrides.push(
          Object.freeze({ ...override, files: Object.freeze(files) }),
        );
    }
  }

  return {
    settings,
    overrides: Object.freeze(overrides),
    limitations: Object.freeze([...new Set(limitations)]),
    executableConfigs: Object.freeze(
      executableConfigs
        .filter(
          (entry, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.projectRoot === entry.projectRoot &&
                candidate.configPath === entry.configPath,
            ) === index,
        )
        .sort(
          (left, right) =>
            left.projectRoot.localeCompare(right.projectRoot) ||
            left.configPath.localeCompare(right.configPath),
        ),
    ),
    sharedConfigs: Object.freeze(
      sharedConfigs
        .filter(
          (entry, index, all) =>
            all.findIndex(
              (candidate) =>
                candidate.projectRoot === entry.projectRoot &&
                candidate.configPath === entry.configPath,
            ) === index,
        )
        .sort(
          (left, right) =>
            left.projectRoot.localeCompare(right.projectRoot) ||
            left.configPath.localeCompare(right.configPath),
        ),
    ),
  };
}
