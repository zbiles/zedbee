import type {
  ImportableNativeConfig,
  ProjectFormatSupport,
  ProjectFormatResult,
  ProjectPrettierFailure,
  ProjectPrettierReply,
  ProjectPrettierRequest,
} from "./project-types.js";
import {
  formattingSettingsSchema,
  type FormattingSettings,
} from "./settings.js";
import { normalizeRepositoryRelativePath } from "../../attribution/fingerprint.js";

const KNOWN_FAILURE_CODES: ReadonlySet<string> = new Set([
  "PROJECT_PRETTIER_TRUST_REQUIRED",
  "PROJECT_PRETTIER_INSTALL_MISSING",
  "PROJECT_PRETTIER_VERSION_UNSUPPORTED",
  "PROJECT_PRETTIER_LAYOUT_UNSUPPORTED",
  "PROJECT_PRETTIER_CONFIG_INVALID",
  "PROJECT_PRETTIER_PLUGIN_MISSING",
  "PROJECT_PRETTIER_WORKER_FAILED",
  "PROJECT_PRETTIER_PROTOCOL_INVALID",
  "PROJECT_PRETTIER_OUTPUT_LIMIT",
  "PROJECT_PRETTIER_PLAN_STALE",
]);

export const PROJECT_PROTOCOL_MAX_BYTES = 8 * 1024 * 1024;
export const PROJECT_FORMAT_SOURCE_MAX_BYTES = 4 * 1024 * 1024;
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
  if (value.operation === "classify") {
    if (
      !exactKeys(value, ["id", "operation", "file"]) ||
      typeof value.file !== "string"
    ) {
      throw new TypeError("Invalid project formatter request fields");
    }
    normalizeRepositoryRelativePath(value.file);
    return { id: value.id, operation: "classify", file: value.file };
  }
  if (value.operation === "format") {
    if (!exactKeys(value, ["id", "operation", "file", "source"])) {
      throw new TypeError("Invalid project formatter request fields");
    }
    if (typeof value.file !== "string" || typeof value.source !== "string") {
      throw new TypeError("Invalid project formatter request");
    }
    normalizeRepositoryRelativePath(value.file);
    if (byteLength(value.source) > PROJECT_FORMAT_SOURCE_MAX_BYTES) {
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
    if ("configPackage" in value) {
      if (
        !exactKeys(value, ["id", "operation", "configPackage"]) ||
        typeof value.configPackage !== "string" ||
        value.configPackage.length === 0 ||
        value.configPackage.length > 214 ||
        value.configPackage.startsWith(".") ||
        value.configPackage.startsWith("/")
      ) {
        throw new TypeError("Invalid project formatter request fields");
      }
      return {
        id: value.id,
        operation: "importConfig",
        configPackage: value.configPackage,
      };
    }
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

function parseIgnoredResult(
  value: Record<string, unknown>,
): Extract<ProjectFormatSupport, { kind: "ignored" }> {
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

function parseSupportResult(value: unknown): ProjectFormatSupport {
  if (!isRecord(value) || typeof value.kind !== "string") {
    throw new TypeError("Invalid project format support result");
  }
  if (value.kind === "supported") {
    if (!exactKeys(value, ["kind"])) {
      throw new TypeError("Invalid supported result");
    }
    return { kind: "supported" };
  }
  if (value.kind === "ignored") return parseIgnoredResult(value);
  throw new TypeError("Invalid project format support result");
}

function parseSettings(value: unknown, field: string): Partial<FormattingSettings> {
  const parsed = formattingSettingsSchema
    .partial()
    .strict()
    .safeParse(value);
  if (!parsed.success) {
    throw new TypeError(`Invalid ${field} in the project formatter reply`);
  }
  return parsed.data as unknown as Partial<FormattingSettings>;
}

function parsePatternList(value: unknown, field: string): string | readonly string[] {
  if (typeof value === "string" && value.length > 0) return value;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(
      (item) => typeof item === "string" && item.length > 0,
    )
  ) {
    return Object.freeze([...value]);
  }
  throw new TypeError(`Invalid ${field} pattern in the project formatter reply`);
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
    return parseIgnoredResult(value);
  }
  throw new TypeError("Invalid project format result");
}

function parseFailure(value: unknown): ProjectPrettierFailure {
  if (
    !isRecord(value) ||
    !exactKeys(
      value,
      value.file === undefined
        ? ["code", "message", "projectRoot"]
        : ["code", "message", "projectRoot", "file"],
    ) ||
    typeof value.code !== "string" ||
    !KNOWN_FAILURE_CODES.has(value.code) ||
    typeof value.message !== "string" ||
    value.message.length === 0 ||
    value.message.length > 4096 ||
    typeof value.projectRoot !== "string" ||
    (value.file !== undefined && typeof value.file !== "string")
  ) {
    throw new TypeError("Invalid project formatter failure");
  }
  return {
    code: value.code as ProjectPrettierFailure["code"],
    message: value.message,
    projectRoot: value.projectRoot,
    ...(value.file === undefined ? {} : { file: value.file }),
  };
}

function parseImportableConfig(
  value: unknown,
): ImportableNativeConfig {
  if (!isRecord(value) || !exactKeys(value, ["settings", "overrides", "limitations"])) {
    throw new TypeError("Invalid imported configuration reply");
  }
  const settings = parseSettings(value.settings, "imported settings");
  if (!Array.isArray(value.overrides) || value.overrides.length > 256) {
    throw new TypeError("Invalid imported configuration overrides");
  }
  const overrides = value.overrides.map((entry) => {
    if (!isRecord(entry)) {
      throw new TypeError("Invalid imported configuration override");
    }
    const keys = Object.keys(entry).filter((key) => key !== "excludeFiles");
    if (
      keys.length !== 2 ||
      !keys.includes("files") ||
      !keys.includes("settings")
    ) {
      throw new TypeError("Invalid imported configuration override fields");
    }
    const files = parsePatternList(entry.files, "override files");
    const excludeFiles =
      entry.excludeFiles === undefined
        ? undefined
        : parsePatternList(entry.excludeFiles, "override excludeFiles");
    const overrideSettings = parseSettings(
      entry.settings,
      "override settings",
    );
    if (Object.keys(overrideSettings).length === 0) {
      throw new TypeError("Imported configuration override has no settings");
    }
    return {
      files,
      ...(excludeFiles === undefined ? {} : { excludeFiles }),
      settings: overrideSettings,
    };
  });
  if (
    !Array.isArray(value.limitations) ||
    value.limitations.length > 64 ||
    value.limitations.some(
      (entry) => typeof entry !== "string" || entry.length === 0 || entry.length > 1024,
    )
  ) {
    throw new TypeError("Invalid imported configuration limitations");
  }
  return Object.freeze({
    settings,
    overrides: Object.freeze(overrides),
    limitations: Object.freeze([...value.limitations]),
  });
}

export function parseProjectReply(
  value: unknown,
  expectedId: number,
): ProjectPrettierReply {
  if (!isRecord(value) || value.id !== expectedId) {
    throw new TypeError("Project formatter reply does not match its request");
  }
  if (value.operation === "classify") {
    if (!exactKeys(value, ["id", "operation", "result"])) {
      throw new TypeError("Invalid project formatter reply fields");
    }
    return {
      id: expectedId,
      operation: "classify",
      result: parseSupportResult(value.result),
    };
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
    if (byteLength(JSON.stringify(value.result)) > MAX_CONFIG_BYTES * 4) {
      throw new TypeError("Imported configuration exceeds its limit");
    }
    return {
      id: expectedId,
      operation: "importConfig",
      result: parseImportableConfig(value.result),
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
