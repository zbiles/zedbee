import { repositoryConfigPath } from "./selection-path.js";
import { constants } from "node:fs";
import { access, open } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import type { GitClient } from "../git/client.js";
import { GitCommandError } from "../git/errors.js";
import { resolveConfig } from "./profiles.js";
import {
  configFileSchema,
  type CheckId,
  type ResolvedConfig,
} from "./schema.js";
import { isCheckId } from "../core/check-ids.js";
import { managedPolicyKeys, managedSettingKeys } from "./settings-registry.js";

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
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
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
  return managedPolicyKeys(checkId);
}

function settingFields(checkId: CheckId): readonly string[] {
  return managedSettingKeys(checkId);
}

function checkPath(
  path: string,
): { checkId: CheckId; tail: string[] } | undefined {
  const parts = path.split(".");
  const checksIndex = parts.lastIndexOf("checks");
  const checkId = parts[checksIndex + 1];
  if (checksIndex < 0 || checkId === undefined || !isCheckId(checkId)) {
    return undefined;
  }
  return {
    checkId,
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

export async function readWorkingTreeConfig(
  configPath: string,
): Promise<string> {
  const tooLarge = () =>
    new ConfigError(
      "CONFIG_INVALID",
      `Zedbee configuration ${basename(configPath)} is too large or could not be read safely from the working tree.`,
      configPath,
    );
  const handle = await open(
    configPath,
    constants.O_RDONLY | constants.O_NONBLOCK,
  );
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.size > CONFIG_CONTENT_LIMIT_BYTES) {
      throw tooLarge();
    }
    const buffer = Buffer.allocUnsafe(CONFIG_CONTENT_LIMIT_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (bytesRead === 0) {
        break;
      }
      length += bytesRead;
    }
    if (length > CONFIG_CONTENT_LIMIT_BYTES) {
      throw tooLarge();
    }
    return buffer.toString("utf8", 0, length);
  } finally {
    await handle.close();
  }
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
    const present = await Promise.all(
      UNSUPPORTED_CONFIG_FILENAMES.map((filename) =>
        exists(join(repositoryRoot, filename)),
      ),
    );
    const unsupportedIndex = present.indexOf(true);
    if (unsupportedIndex !== -1) {
      throw unsupportedGitConfig(
        repositoryRoot,
        UNSUPPORTED_CONFIG_FILENAMES[unsupportedIndex]!,
      );
    }
    return resolveConfig(undefined);
  }

  const source = await readWorkingTreeConfig(configPath);
  return parseConfigSource(source, configPath);
}

function parseJsonc(
  source: string,
  configPath: string,
  parseErrors: ParseError[],
): unknown {
  try {
    return parse(source, parseErrors, {
      allowTrailingComma: true,
      disallowComments: false,
    });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new ConfigError(
      "CONFIG_INVALID",
      `Invalid Zedbee configuration at ${basename(configPath)}: values are nested too deeply.`,
      configPath,
    );
  }
}

function parseConfigSource(source: string, configPath: string): ResolvedConfig {
  const parseErrors: ParseError[] = [];
  const value: unknown = parseJsonc(source, configPath, parseErrors);

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

  try {
    return resolveConfig(parsed.data, configPath);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ConfigError(
      "CONFIG_INVALID",
      `Invalid Zedbee configuration at ${basename(configPath)}: ${error.message}`,
      configPath,
    );
  }
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
      throw unreadableGitConfig(configPath, "the Git index");
    }
    const path = remaining.slice(0, pathEnd);
    const metadata = remaining.slice(pathEnd + 1);
    const match = INDEX_DEBUG_METADATA.exec(metadata);
    if (match === null) {
      throw unreadableGitConfig(configPath, "the Git index");
    }
    if ((Number.parseInt(match[1]!, 16) & INTENT_TO_ADD_FLAG) !== 0) {
      paths.add(path);
    }
    remaining = metadata.slice(match[0].length);
  }
  return paths;
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
        throw unreadableGitConfig(configPath, "the Git index");
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
    throw unreadableGitConfig(configPath, "the target Git commit");
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
        throw unreadableGitConfig(configPath, "the target Git commit");
      }
      return {
        mode: match[1]!,
        type: match[2]!,
        objectId: match[3]!,
        path,
      };
    });
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

async function targetTreeEntries(
  git: GitClient,
  targetCommit: string,
  repositoryPaths: readonly string[],
  configPath: string,
  signal?: AbortSignal,
): Promise<ReadonlyMap<string, TreeEntry>> {
  let result: Awaited<ReturnType<GitClient["run"]>>;
  try {
    result = await git.run(
      [
        "ls-tree",
        "-z",
        targetCommit,
        "--",
        ...repositoryPaths.map(literalPathspec),
      ],
      {
        maxOutputBytes: INDEX_QUERY_OUTPUT_LIMIT_BYTES,
        ...(signal === undefined ? {} : { signal }),
      },
    );
  } catch (error) {
    if (signal?.aborted === true || isGitResourceFailure(error)) throw error;
    throw unreadableGitConfig(configPath, "the target Git commit");
  }
  const entries = new Map<string, TreeEntry>();
  for (const entry of parseTreeEntries(result.stdout, configPath)) {
    if (!repositoryPaths.includes(entry.path) || entries.has(entry.path)) {
      throw unreadableGitConfig(configPath, "the target Git commit");
    }
    entries.set(entry.path, entry);
  }
  return entries;
}

function selectGitConfigPath(
  repositoryRoot: string,
  explicitConfigPath?: string,
) {
  const configPath =
    explicitConfigPath ?? join(repositoryRoot, CONFIG_FILENAME);
  const repositoryPath = repositoryConfigPath(repositoryRoot, configPath);
  if (repositoryPath === undefined) {
    throw new ConfigError(
      "CONFIG_INVALID",
      "Selected configuration must be inside the repository.",
      configPath,
    );
  }
  return { configPath, repositoryPath };
}

async function readGitConfigBlob(
  git: GitClient,
  objectId: string,
  configPath: string,
  location: "the Git index" | "the target Git commit",
  signal?: AbortSignal,
): Promise<ResolvedConfig> {
  let source: Awaited<ReturnType<GitClient["run"]>>;
  try {
    source = await git.run(["cat-file", "blob", objectId], {
      maxOutputBytes: CONFIG_CONTENT_LIMIT_BYTES,
      ...(signal === undefined ? {} : { signal }),
    });
  } catch (error) {
    if (signal?.aborted === true || isGitResourceFailure(error)) throw error;
    throw new ConfigError(
      "CONFIG_INVALID",
      `Zedbee configuration ${basename(configPath)} is too large or could not be read safely from ${location}.`,
      configPath,
    );
  }
  return parseConfigSource(source.stdout, configPath);
}

function unreadableGitConfig(
  configPath: string,
  location: "the Git index" | "the target Git commit",
): ConfigError {
  return new ConfigError(
    "CONFIG_INVALID",
    `Zedbee could not safely read ${basename(configPath)} from ${location}.`,
    configPath,
  );
}

function missingExplicitGitConfig(
  configPath: string,
  location: "the Git index" | "the target Git commit",
): ConfigError {
  return new ConfigError(
    "CONFIG_INVALID",
    `Zedbee configuration file ${basename(configPath)} does not exist in ${location}.`,
    configPath,
  );
}

function unsupportedGitConfig(
  repositoryRoot: string,
  filename: string,
): ConfigError {
  return new ConfigError(
    "CONFIG_UNSUPPORTED",
    `Unsupported Zedbee configuration file ${filename}; use ${CONFIG_FILENAME}.`,
    join(repositoryRoot, filename),
  );
}

export async function loadConfigFromIndex(
  repositoryRoot: string,
  git: GitClient,
  explicitConfigPath?: string,
  signal?: AbortSignal,
): Promise<ResolvedConfig> {
  const { configPath, repositoryPath } = selectGitConfigPath(
    repositoryRoot,
    explicitConfigPath,
  );
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
    throw unreadableGitConfig(configPath, "the Git index");
  }
  const selectedEntries = entries.get(repositoryPath) ?? [];
  if (selectedEntries.length === 0) {
    if (explicitConfigPath !== undefined) {
      throw missingExplicitGitConfig(configPath, "the Git index");
    }
    for (const filename of UNSUPPORTED_CONFIG_FILENAMES) {
      if ((entries.get(filename) ?? []).length > 0) {
        throw unsupportedGitConfig(repositoryRoot, filename);
      }
    }
    return resolveConfig(undefined);
  }

  const entry = singleRegularEntry(selectedEntries, configPath);
  return readGitConfigBlob(
    git,
    entry.objectId,
    configPath,
    "the Git index",
    signal,
  );
}

export async function loadConfigFromCommit(
  repositoryRoot: string,
  git: GitClient,
  targetCommit: string,
  explicitConfigPath?: string,
  signal?: AbortSignal,
): Promise<ResolvedConfig> {
  const { configPath, repositoryPath } = selectGitConfigPath(
    repositoryRoot,
    explicitConfigPath,
  );

  const candidatePaths =
    explicitConfigPath === undefined
      ? [CONFIG_FILENAME, ...UNSUPPORTED_CONFIG_FILENAMES]
      : [repositoryPath];
  const entries = await targetTreeEntries(
    git,
    targetCommit,
    candidatePaths,
    configPath,
    signal,
  );
  const entry = entries.get(repositoryPath);
  if (entry === undefined) {
    if (explicitConfigPath !== undefined) {
      throw missingExplicitGitConfig(configPath, "the target Git commit");
    }
    const unsupported = UNSUPPORTED_CONFIG_FILENAMES.find((filename) =>
      entries.has(filename),
    );
    if (unsupported !== undefined) {
      throw unsupportedGitConfig(repositoryRoot, unsupported);
    }
    return resolveConfig(undefined);
  }

  const regularEntry = singleRegularTreeEntry(entry, configPath);
  return readGitConfigBlob(
    git,
    regularEntry.objectId,
    configPath,
    "the target Git commit",
    signal,
  );
}
