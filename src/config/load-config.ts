import { access, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { resolveConfig } from "./profiles.js";
import { configFileSchema, type ResolvedConfig } from "./schema.js";

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
    const issuePath = parsed.error.issues[0]?.path.join(".") || "root";
    throw new ConfigError(
      "CONFIG_INVALID",
      `Invalid Zedbee configuration at ${basename(configPath)} (${issuePath}).`,
      configPath,
    );
  }

  return resolveConfig(parsed.data, configPath);
}
