import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
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
