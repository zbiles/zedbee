import { access, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { GitClient } from "../git/client.js";
import { GitCommandError } from "../git/errors.js";
import { resolveConfig } from "./profiles.js";
import {
  CHECK_IDS,
  configFileSchema,
  type CheckId,
  type ResolvedConfig,
} from "./schema.js";
import { DEFAULT_FORMATTING_SETTINGS } from "../checks/prettier/settings.js";
import { DEFAULT_DUPLICATION_SETTINGS } from "../checks/duplication/settings.js";

const CONFIG_FILENAME = ".zedbeerc.jsonc";
const UNSUPPORTED_CONFIG_FILENAMES = [
  ".zedbeerc.js",
  ".zedbeerc.cjs",
  ".zedbeerc.mjs",
  ".zedbeerc.ts",
  ".zedbeerc.json",
] as const;
const INDEX_QUERY_OUTPUT_LIMIT_BYTES = 64 * 1024;
const CONFIG_CONTENT_LIMIT_BYTES = 1024 * 1024;

function isGitResourceFailure(error: unknown): boolean {
  return (
    error instanceof GitCommandError &&
    (error.code === "GIT_ABORTED" || error.code === "GIT_HARD_TIMEOUT")
  );
}

export type ConfigErrorCode = "CONFIG_INVALID" | "CONFIG_UNSUPPORTED";

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  readonly configPath: string;
  readonly line?: number;
  readonly column?: number;

  constructor(
    code: ConfigErrorCode,
    message: string,
    configPath: string,
    location?: { line: number; column: number },
  ) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.configPath = configPath;
    if (location !== undefined) {
      this.line = location.line;
      this.column = location.column;
    }
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function lineAndColumn(
  source: string,
  offset: number,
): { line: number; column: number } {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return {
    line: lines.length,
    column: (lines.at(-1)?.length ?? 0) + 1,
  };
}

function invalidJsonc(
  configPath: string,
  source: string,
  error: ParseError,
): ConfigError {
  const location = lineAndColumn(source, error.offset);
  return new ConfigError(
    "CONFIG_INVALID",
    `Invalid Zedbee configuration at ${basename(configPath)}:${location.line}:${location.column} (${printParseErrorCode(error.error)}).`,
    configPath,
    location,
  );
}

type ValidationIssue = {
  readonly code?: string;
  readonly path: readonly (string | number)[];
  readonly keys?: readonly string[];
  readonly errors?: readonly (readonly ValidationIssue[])[];
  readonly unionErrors?: readonly {
    readonly issues: readonly ValidationIssue[];
  }[];
};

function flattenIssues(issue: ValidationIssue): ValidationIssue[] {
  return [
    issue,
    ...(issue.errors ?? []).flatMap((issues) => issues.flatMap(flattenIssues)),
    ...(issue.unionErrors ?? []).flatMap((error) =>
      error.issues.flatMap(flattenIssues),
    ),
  ];
}

function issuePath(issue: ValidationIssue): string {
  const path = [...issue.path];
  if (issue.code === "unrecognized_keys" && issue.keys?.[0] !== undefined) {
    path.push(issue.keys[0]);
  }
  return path.length === 0 ? "root" : path.map(String).join(".");
}

function policyFields(checkId: CheckId): readonly string[] {
  switch (checkId) {
    case "formatting":
      return ["severity", "when", "settings"];
    case "duplication":
      return ["severity", "when", "threshold", "settings"];
    case "cyclomaticComplexity":
    case "readabilityComplexity":
      return ["severity", "when", "max", "blockWorsening"];
    case "vulnerabilities":
      return ["severity", "when", "onUnavailable"];
    default:
      return ["severity", "when"];
  }
}

function settingFields(checkId: CheckId): readonly string[] {
  switch (checkId) {
    case "formatting":
      return Object.keys(DEFAULT_FORMATTING_SETTINGS);
    case "duplication":
      return Object.keys(DEFAULT_DUPLICATION_SETTINGS);
    default:
      return [];
  }
}

function checkPath(
  path: string,
): { checkId: CheckId; tail: string[] } | undefined {
  const parts = path.split(".");
  const checksIndex = parts.lastIndexOf("checks");
  const checkId = parts[checksIndex + 1];
  if (
    checksIndex < 0 ||
    checkId === undefined ||
    !CHECK_IDS.includes(checkId as CheckId)
  ) {
    return undefined;
  }
  return {
    checkId: checkId as CheckId,
    tail: parts.slice(checksIndex + 2),
  };
}

function supportedNames(path: string): readonly string[] {
  const parsed = checkPath(path);
  if (parsed === undefined || parsed.tail.length === 0) return [];
  if (parsed.tail[0] === "settings") {
    return parsed.tail.length > 1 ? settingFields(parsed.checkId) : [];
  }
  return policyFields(parsed.checkId);
}

function invalidConfigMessage(
  configPath: string,
  issue: ValidationIssue,
): string {
  const best = flattenIssues(issue)
    .filter((candidate) => candidate.code !== "invalid_union")
    .sort((left, right) => issuePath(right).length - issuePath(left).length)[0];
  const selected = best ?? issue;
  const selectedPath = issuePath(selected);
  const parentPath = issue.path.map(String).join(".");
  const path =
    parentPath !== "" &&
    selectedPath !== "root" &&
    !selectedPath.startsWith(parentPath)
      ? `${parentPath}.${selectedPath}`
      : selectedPath;
  const supported = supportedNames(path);
  const help =
    supported.length === 0
      ? ""
      : ` Supported settings include ${supported.join(", ")}.`;
  return `Invalid Zedbee configuration at ${basename(configPath)} (${path}).${help}`;
}

export async function loadConfig(
  repositoryRoot: string,
  explicitConfigPath?: string,
): Promise<ResolvedConfig> {
  const configPath =
    explicitConfigPath ?? join(repositoryRoot, CONFIG_FILENAME);
  if (!(await exists(configPath))) {
    if (explicitConfigPath !== undefined) {
      throw new ConfigError(
        "CONFIG_INVALID",
        `Zedbee configuration file ${basename(configPath)} does not exist.`,
        configPath,
      );
    }
    for (const filename of UNSUPPORTED_CONFIG_FILENAMES) {
      const unsupportedPath = join(repositoryRoot, filename);
      if (await exists(unsupportedPath)) {
        throw new ConfigError(
          "CONFIG_UNSUPPORTED",
          `Unsupported Zedbee configuration file ${filename}; use ${CONFIG_FILENAME}.`,
          unsupportedPath,
        );
      }
    }
    return resolveConfig(undefined);
  }

  const source = await readFile(configPath, "utf8");
  return parseConfigSource(source, configPath);
}

function parseConfigSource(source: string, configPath: string): ResolvedConfig {
  const parseErrors: ParseError[] = [];
  const value: unknown = parse(source, parseErrors, {
    allowTrailingComma: true,
    disallowComments: false,
  });

  const firstParseError = parseErrors[0];
  if (firstParseError !== undefined) {
    throw invalidJsonc(configPath, source, firstParseError);
  }

  const parsed = configFileSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0] as ValidationIssue | undefined;
    throw new ConfigError(
      "CONFIG_INVALID",
      issue === undefined
        ? `Invalid Zedbee configuration at ${basename(configPath)} (root).`
        : invalidConfigMessage(configPath, issue),
      configPath,
    );
  }

  return resolveConfig(parsed.data, configPath);
}

interface IndexEntry {
  readonly mode: string;
  readonly objectId: string;
  readonly stage: string;
  readonly path: string;
}

interface TreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly objectId: string;
  readonly path: string;
}

const INTENT_TO_ADD_FLAG = 0x20000000;
const INDEX_DEBUG_METADATA =
  /^  ctime: \d+:\d+\n  mtime: \d+:\d+\n  dev: \d+\tino: \d+\n  uid: \d+\tgid: \d+\n  size: \d+\tflags: ([\da-f]+)(?:\n|$)/u;

function parseIntentToAddPaths(
  output: string,
  configPath: string,
): ReadonlySet<string> {
  const paths = new Set<string>();
  let remaining = output;
  while (remaining !== "") {
    const pathEnd = remaining.indexOf("\0");
    if (pathEnd === -1) {
      throw new ConfigError(
        "CONFIG_INVALID",
        `Zedbee could not safely read ${basename(configPath)} from the Git index.`,
        configPath,
      );
    }
    const path = remaining.slice(0, pathEnd);
    const metadata = remaining.slice(pathEnd + 1);
    const match = INDEX_DEBUG_METADATA.exec(metadata);
    if (match === null) {
      throw new ConfigError(
        "CONFIG_INVALID",
        `Zedbee could not safely read ${basename(configPath)} from the Git index.`,
        configPath,
      );
    }
    if ((Number.parseInt(match[1]!, 16) & INTENT_TO_ADD_FLAG) !== 0) {
      paths.add(path);
    }
    remaining = metadata.slice(match[0].length);
  }
  return paths;
}

function repositoryRelativePath(
  repositoryRoot: string,
  path: string,
): string | undefined {
  const fromRoot = relative(repositoryRoot, path);
  if (
    fromRoot === "" ||
    isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`)
  ) {
    return undefined;
  }
  return fromRoot.split(sep).join("/");
}

function parseIndexEntries(output: string, configPath: string): IndexEntry[] {
  return output
    .split("\0")
    .filter((record) => record !== "")
    .map((record) => {
      const separator = record.indexOf("\t");
      const header = separator === -1 ? "" : record.slice(0, separator);
      const path = separator === -1 ? "" : record.slice(separator + 1);
      const match = /^(\d{6}) ([0-9a-f]+) ([0-3])$/u.exec(header);
      if (match === null || path === "") {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Zedbee could not safely read ${basename(configPath)} from the Git index.`,
          configPath,
        );
      }
      return {
        mode: match[1]!,
        objectId: match[2]!,
        stage: match[3]!,
        path,
      };
    });
}

function literalPathspec(path: string): string {
  return `:(literal)${path}`;
}

async function indexedEntries(
  git: GitClient,
  paths: readonly string[],
  configPath: string,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, readonly IndexEntry[]>> {
  const pathspecs = paths.map(literalPathspec);
  const [result, debug] = await Promise.all([
    git.run(["ls-files", "--stage", "-z", "--", ...pathspecs], {
      maxOutputBytes: INDEX_QUERY_OUTPUT_LIMIT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    }),
    git.run(["ls-files", "--debug", "-z", "--", ...pathspecs], {
      maxOutputBytes: INDEX_QUERY_OUTPUT_LIMIT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    }),
  ]);
  const intentToAdd = parseIntentToAddPaths(debug.stdout, configPath);
  const grouped = new Map<string, IndexEntry[]>();
  for (const entry of parseIndexEntries(result.stdout, configPath)) {
    if (intentToAdd.has(entry.path)) continue;
    const entries = grouped.get(entry.path) ?? [];
    entries.push(entry);
    grouped.set(entry.path, entries);
  }
  return grouped;
}

function singleRegularEntry(
  entries: readonly IndexEntry[],
  configPath: string,
): IndexEntry {
  const entry = entries[0];
  if (
    entries.length !== 1 ||
    entry === undefined ||
    entry.stage !== "0" ||
    (entry.mode !== "100644" && entry.mode !== "100755")
  ) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Zedbee configuration ${basename(configPath)} must be a regular resolved file in the Git index.`,
      configPath,
    );
  }
  return entry;
}

function parseTreeEntries(output: string, configPath: string): TreeEntry[] {
  if (output === "") return [];
  if (!output.endsWith("\0")) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Zedbee could not safely read ${basename(configPath)} from the target Git commit.`,
      configPath,
    );
  }
  return output
    .slice(0, -1)
    .split("\0")
    .map((record) => {
      const separator = record.indexOf("\t");
      const header = separator === -1 ? "" : record.slice(0, separator);
      const path = separator === -1 ? "" : record.slice(separator + 1);
      const match = /^(\d{6}) ([a-z]+) ([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(
        header,
      );
      if (match === null || path === "") {
        throw new ConfigError(
          "CONFIG_INVALID",
          `Zedbee could not safely read ${basename(configPath)} from the target Git commit.`,
          configPath,
        );
      }
      return {
        mode: match[1]!,
        type: match[2]!,
        objectId: match[3]!,
        path,
      };
    });
}

function singleTreeEntry(
  output: string,
  repositoryPath: string,
  configPath: string,
): TreeEntry | undefined {
  const entries = parseTreeEntries(output, configPath);
  const entry = entries[0];
  if (entries.length === 0) return undefined;
  if (
    entries.length !== 1 ||
    entry === undefined ||
    entry.path !== repositoryPath
  ) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Zedbee could not safely read ${basename(configPath)} from the target Git commit.`,
      configPath,
    );
  }
  return entry;
}

function singleRegularTreeEntry(
  entry: TreeEntry,
  configPath: string,
): TreeEntry {
  if (
    entry.type !== "blob" ||
    (entry.mode !== "100644" && entry.mode !== "100755")
  ) {
    throw new ConfigError(
      "CONFIG_INVALID",
      `Zedbee configuration ${basename(configPath)} must be a regular file in the target Git commit.`,
      configPath,
    );
  }
  return entry;
}

async function targetTreeEntry(
  git: GitClient,
  targetCommit: string,
  repositoryPath: string,
  configPath: string,
  signal?: AbortSignal,
): Promise<TreeEntry | undefined> {
  let result: Awaited<ReturnType<GitClient["run"]>>;
  try {
    result = await git.run(
      ["ls-tree", "-z", targetCommit, "--", literalPathspec(repositoryPath)],
      {
        maxOutputBytes: INDEX_QUERY_OUTPUT_LIMIT_BYTES,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch (error) {
    if (signal?.aborted === true || isGitResourceFailure(error)) throw error;
    throw new ConfigError(
      "CONFIG_INVALID",
      `Zedbee could not safely read ${basename(configPath)} from the target Git commit.`,
      configPath,
    );
  }
  return singleTreeEntry(result.stdout, repositoryPath, configPath);
}

export async function loadConfigFromIndex(
  repositoryRoot: string,
  git: GitClient,
  explicitConfigPath?: string,
  signal?: AbortSignal,
): Promise<ResolvedConfig> {
  const configPath =
    explicitConfigPath ?? join(repositoryRoot, CONFIG_FILENAME);
  const repositoryPath = repositoryRelativePath(repositoryRoot, configPath);
  if (repositoryPath === undefined) {
    return loadConfig(repositoryRoot, explicitConfigPath);
  }

  const candidatePaths =
    explicitConfigPath === undefined
      ? [CONFIG_FILENAME, ...UNSUPPORTED_CONFIG_FILENAMES]
      : [repositoryPath];
  let entries: ReadonlyMap<string, readonly IndexEntry[]>;
  try {
    entries = await indexedEntries(git, candidatePaths, configPath, signal);
  } catch (error) {
    if (
      signal?.aborted === true ||
      error instanceof ConfigError ||
      isGitResourceFailure(error)
    ) {
      throw error;
    }
    throw new ConfigError(
      "CONFIG_INVALID",
      `Zedbee could not safely read ${basename(configPath)} from the Git index.`,
      configPath,
    );
  }
  const selectedEntries = entries.get(repositoryPath) ?? [];
  if (selectedEntries.length === 0) {
    if (explicitConfigPath !== undefined) {
      throw new ConfigError(
        "CONFIG_INVALID",
        `Zedbee configuration file ${basename(configPath)} does not exist in the Git index.`,
        configPath,
      );
    }
    for (const filename of UNSUPPORTED_CONFIG_FILENAMES) {
      if ((entries.get(filename) ?? []).length > 0) {
        throw new ConfigError(
          "CONFIG_UNSUPPORTED",
          `Unsupported Zedbee configuration file ${filename}; use ${CONFIG_FILENAME}.`,
          join(repositoryRoot, filename),
        );
      }
    }
    return resolveConfig(undefined);
  }

  const entry = singleRegularEntry(selectedEntries, configPath);
  let source: Awaited<ReturnType<GitClient["run"]>>;
  try {
    source = await git.run(["cat-file", "blob", entry.objectId], {
      maxOutputBytes: CONFIG_CONTENT_LIMIT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true || isGitResourceFailure(error)) throw error;
    throw new ConfigError(
      "CONFIG_INVALID",
      `Zedbee configuration ${basename(configPath)} is too large or could not be read safely from the Git index.`,
      configPath,
    );
  }
  return parseConfigSource(source.stdout, configPath);
}

export async function loadConfigFromCommit(
  repositoryRoot: string,
  git: GitClient,
  targetCommit: string,
  explicitConfigPath?: string,
  signal?: AbortSignal,
): Promise<ResolvedConfig> {
  const configPath =
    explicitConfigPath ?? join(repositoryRoot, CONFIG_FILENAME);
  const repositoryPath = repositoryRelativePath(repositoryRoot, configPath);
  if (repositoryPath === undefined) {
    return loadConfig(repositoryRoot, explicitConfigPath);
  }

  const entry = await targetTreeEntry(
    git,
    targetCommit,
    repositoryPath,
    configPath,
    signal,
  );
  if (entry === undefined) {
    if (explicitConfigPath !== undefined) {
      throw new ConfigError(
        "CONFIG_INVALID",
        `Zedbee configuration file ${basename(configPath)} does not exist in the target Git commit.`,
        configPath,
      );
    }
    for (const filename of UNSUPPORTED_CONFIG_FILENAMES) {
      const unsupported = await targetTreeEntry(
        git,
        targetCommit,
        filename,
        configPath,
        signal,
      );
      if (unsupported !== undefined) {
        throw new ConfigError(
          "CONFIG_UNSUPPORTED",
          `Unsupported Zedbee configuration file ${filename}; use ${CONFIG_FILENAME}.`,
          join(repositoryRoot, filename),
        );
      }
    }
    return resolveConfig(undefined);
  }

  const regularEntry = singleRegularTreeEntry(entry, configPath);
  let source: Awaited<ReturnType<GitClient["run"]>>;
  try {
    source = await git.run(["cat-file", "blob", regularEntry.objectId], {
      maxOutputBytes: CONFIG_CONTENT_LIMIT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true || isGitResourceFailure(error)) throw error;
    throw new ConfigError(
      "CONFIG_INVALID",
      `Zedbee configuration ${basename(configPath)} is too large or could not be read safely from the target Git commit.`,
      configPath,
    );
  }
  return parseConfigSource(source.stdout, configPath);
}
