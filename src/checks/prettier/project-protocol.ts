import type {
  ProjectFormatResult,
  ProjectPrettierFailure,
  ProjectPrettierReply,
  ProjectPrettierRequest,
} from "./project-types.js";
import type { FormattingSettings } from "./settings.js";
import { normalizeRepositoryRelativePath } from "../../attribution/fingerprint.js";

export const PROJECT_PROTOCOL_MAX_BYTES = 8 * 1024 * 1024;
const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const MAX_CONFIG_BYTES = 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const own = Object.keys(value);
  return (
    own.length === keys.length && own.every((key) => keys.includes(key))
  );
}

function validId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

export function parseProjectRequest(value: unknown): ProjectPrettierRequest {
  if (!isRecord(value) || !validId(value.id)) {
    throw new TypeError("Invalid project formatter request");
  }
  if (value.operation === "format") {
    if (!exactKeys(value, ["id", "operation", "file", "source"])) {
      throw new TypeError("Invalid project formatter request fields");
    }
    if (typeof value.file !== "string" || typeof value.source !== "string") {
      throw new TypeError("Invalid project formatter request");
    }
    normalizeRepositoryRelativePath(value.file);
    if (byteLength(value.source) > MAX_SOURCE_BYTES) {
      throw new TypeError("Project formatter source exceeds its limit");
    }
    return {
      id: value.id,
      operation: "format",
      file: value.file,
      source: value.source,
    };
  }
  if (value.operation === "importConfig") {
    if (!exactKeys(value, ["id", "operation", "configFile"])) {
      throw new TypeError("Invalid project formatter request fields");
    }
    if (typeof value.configFile !== "string") {
      throw new TypeError("Invalid project formatter request");
    }
    normalizeRepositoryRelativePath(value.configFile);
    return {
      id: value.id,
      operation: "importConfig",
      configFile: value.configFile,
    };
  }
  throw new TypeError("Invalid project formatter operation");
}

function parseSettings(value: unknown): Partial<FormattingSettings> {
  if (!isRecord(value)) throw new TypeError("Invalid imported settings");
  return value as Partial<FormattingSettings>;
}

function parseFormatResult(value: unknown): ProjectFormatResult {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new TypeError("Invalid project format result");
  }
  if (value.kind === "formatted") {
    if (!exactKeys(value, ["kind", "text"]) || typeof value.text !== "string") {
      throw new TypeError("Invalid formatted result");
    }
    if (byteLength(value.text) > PROJECT_PROTOCOL_MAX_BYTES) {
      throw new TypeError("Formatted output exceeds its limit");
    }
    return { kind: "formatted", text: value.text };
  }
  if (value.kind === "ignored") {
    if (
      !exactKeys(value, ["kind", "reason"]) ||
      (value.reason !== "prettierignore" &&
        value.reason !== "gitignore" &&
        value.reason !== "unsupported")
    ) {
      throw new TypeError("Invalid ignored result");
    }
    return { kind: "ignored", reason: value.reason };
  }
  throw new TypeError("Invalid project format result");
}

function parseFailure(value: unknown): ProjectPrettierFailure {
  if (
    !isRecord(value) ||
    typeof value.code !== "string" ||
    typeof value.message !== "string" ||
    typeof value.projectRoot !== "string"
  ) {
    throw new TypeError("Invalid project formatter failure");
  }
  if (value.file !== undefined && typeof value.file !== "string") {
    throw new TypeError("Invalid project formatter failure");
  }
  return {
    code: value.code as ProjectPrettierFailure["code"],
    message: value.message,
    projectRoot: value.projectRoot,
    ...(value.file === undefined ? {} : { file: value.file }),
  };
}

export function parseProjectReply(
  value: unknown,
  expectedId: number,
): ProjectPrettierReply {
  if (!isRecord(value) || value.id !== expectedId) {
    throw new TypeError("Project formatter reply does not match its request");
  }
  if (value.operation === "format") {
    if (!exactKeys(value, ["id", "operation", "result"])) {
      throw new TypeError("Invalid project formatter reply fields");
    }
    return {
      id: expectedId,
      operation: "format",
      result: parseFormatResult(value.result),
    };
  }
  if (value.operation === "importConfig") {
    if (!exactKeys(value, ["id", "operation", "result"])) {
      throw new TypeError("Invalid project formatter reply fields");
    }
    const result = value.result as Record<string, unknown>;
    if (
      !isRecord(result) ||
      !exactKeys(result, ["settings", "overrides", "limitations"]) ||
      !Array.isArray(result.overrides) ||
      !Array.isArray(result.limitations)
    ) {
      throw new TypeError("Invalid imported configuration reply");
    }
    if (byteLength(JSON.stringify(result)) > MAX_CONFIG_BYTES * 4) {
      throw new TypeError("Imported configuration exceeds its limit");
    }
    return {
      id: expectedId,
      operation: "importConfig",
      result: {
        settings: parseSettings(result.settings),
        overrides: result.overrides as never,
        limitations: result.limitations.map((entry) => String(entry)),
      },
    };
  }
  if (value.operation === "error") {
    if (!exactKeys(value, ["id", "operation", "failure"])) {
      throw new TypeError("Invalid project formatter reply fields");
    }
    return {
      id: expectedId,
      operation: "error",
      failure: parseFailure(value.failure),
    };
  }
  throw new TypeError("Invalid project formatter reply operation");
}
