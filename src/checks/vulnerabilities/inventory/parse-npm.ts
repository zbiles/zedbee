import {
  parseTree,
  type Node as JsonNode,
  type ParseError,
} from "jsonc-parser";
import { compareCodeUnits } from "../../../core/compare.js";
import { normalizeRepositoryRelativePath } from "../../../attribution/fingerprint.js";
import { inventoryError, LockfileInventoryError } from "./errors.js";
import {
  MAX_DEPENDENCY_PATH_LENGTH,
  MAX_DEPENDENCY_RECORDS,
  MAX_LOCKFILE_BYTES,
  MAX_LOCKFILE_NESTING,
  MAX_LOCKFILE_NODES,
  MAX_LOCKFILE_STRING_LENGTH,
  MAX_PACKAGE_NAME_LENGTH,
  MAX_PACKAGE_VERSION_LENGTH,
} from "./limits.js";
import { createSourcePositionIndex } from "./source-position.js";
import type { DependencyInventory, DependencyRecord } from "./types.js";

interface JsonProperty {
  readonly key: string;
  readonly keyNode: JsonNode;
  readonly valueNode: JsonNode;
}

function invalid(message: string): never {
  throw inventoryError("LOCKFILE_INVALID", message);
}

function properties(node: JsonNode, field: string): readonly JsonProperty[] {
  if (node.type !== "object") invalid(`The npm lockfile ${field} must be an object.`);
  return (node.children ?? []).map((property) => {
    const [keyNode, valueNode] = property.children ?? [];
    if (
      property.type !== "property" ||
      keyNode?.type !== "string" ||
      typeof keyNode.value !== "string" ||
      valueNode === undefined
    ) {
      return invalid(`The npm lockfile ${field} contains an invalid property.`);
    }
    return { key: keyNode.value, keyNode, valueNode };
  });
}

function property(node: JsonNode, name: string): JsonNode | undefined {
  return properties(node, "data").find(({ key }) => key === name)?.valueNode;
}

function validateTree(root: JsonNode): void {
  let nodes = 0;
  const visit = (node: JsonNode, depth: number): void => {
    nodes += 1;
    if (depth > MAX_LOCKFILE_NESTING || nodes > MAX_LOCKFILE_NODES) {
      throw inventoryError(
        "LOCKFILE_LIMIT_EXCEEDED",
        "The npm lockfile exceeds Zedbee's structural safety limits.",
      );
    }
    if (
      node.type === "string" &&
      typeof node.value === "string" &&
      node.value.length > MAX_LOCKFILE_STRING_LENGTH
    ) {
      throw inventoryError(
        "LOCKFILE_LIMIT_EXCEEDED",
        "The npm lockfile contains an oversized string.",
      );
    }
    for (const child of node.children ?? []) visit(child, depth + 1);
  };
  visit(root, 1);
}

function stringValue(node: JsonNode | undefined): string | undefined {
  return node?.type === "string" && typeof node.value === "string"
    ? node.value
    : undefined;
}

function booleanValue(node: JsonNode | undefined): boolean | undefined {
  return node?.type === "boolean" && typeof node.value === "boolean"
    ? node.value
    : undefined;
}

function packageName(value: string): string {
  if (
    value.length === 0 ||
    value.length > MAX_PACKAGE_NAME_LENGTH ||
    /[\s\\]/u.test(value) ||
    value.startsWith(".") ||
    (value.startsWith("@")
      ? !/^@[^/]+\/[^/]+$/u.test(value)
      : value.includes("/"))
  ) {
    const code =
      value.length > MAX_PACKAGE_NAME_LENGTH
        ? "LOCKFILE_LIMIT_EXCEEDED"
        : "LOCKFILE_INVALID";
    throw inventoryError(code, "The npm lockfile contains an invalid package name.");
  }
  return value;
}

function exactVersion(node: JsonNode | undefined): string {
  const value = stringValue(node);
  if (value === undefined || value.length === 0) {
    throw inventoryError(
      "LOCKFILE_VERSION_MISSING",
      "The npm lockfile contains a package without an exact version.",
    );
  }
  if (value.length > MAX_PACKAGE_VERSION_LENGTH) {
    throw inventoryError(
      "LOCKFILE_LIMIT_EXCEEDED",
      "The npm lockfile contains an oversized package version.",
    );
  }
  if (/[\s|]/u.test(value) || /^[~^<>=*]/u.test(value)) {
    throw inventoryError(
      "LOCKFILE_VERSION_INVALID",
      "The npm lockfile contains a package version that is not exact.",
    );
  }
  return value;
}

function dependencyPathFromPackageKey(packageKey: string): {
  readonly importer?: string;
  readonly dependencyPath: readonly string[];
} | undefined {
  const marker = "node_modules/";
  const first = packageKey.indexOf(marker);
  if (first < 0) return undefined;
  try {
    normalizeRepositoryRelativePath(packageKey);
  } catch {
    throw inventoryError(
      "LOCKFILE_INVALID",
      "The npm lockfile contains an unsafe package path.",
    );
  }
  const importer = packageKey.slice(0, first).replace(/\/$/u, "") || undefined;
  const dependencyPath = packageKey
    .slice(first)
    .split("/node_modules/")
    .map((component) => component.replace(/^node_modules\//u, ""));
  if (
    dependencyPath.length === 0 ||
    dependencyPath.length > MAX_DEPENDENCY_PATH_LENGTH
  ) {
    throw inventoryError(
      "LOCKFILE_LIMIT_EXCEEDED",
      "The npm lockfile contains an oversized dependency path.",
    );
  }
  dependencyPath.forEach(packageName);
  return {
    ...(importer === undefined ? {} : { importer }),
    dependencyPath: Object.freeze(dependencyPath),
  };
}

function freezeRecord(record: DependencyRecord): DependencyRecord {
  if (record.dependencyPath !== undefined) Object.freeze(record.dependencyPath);
  return Object.freeze(record);
}

function compareRecords(left: DependencyRecord, right: DependencyRecord): number {
  return (
    compareCodeUnits(left.name, right.name) ||
    compareCodeUnits(left.version, right.version) ||
    compareCodeUnits(left.importer ?? "", right.importer ?? "") ||
    compareCodeUnits(
      left.dependencyPath?.join("\0") ?? "",
      right.dependencyPath?.join("\0") ?? "",
    ) ||
    (left.line ?? 0) - (right.line ?? 0)
  );
}

function finalize(records: readonly DependencyRecord[]): DependencyInventory {
  if (records.length > MAX_DEPENDENCY_RECORDS) {
    throw inventoryError(
      "LOCKFILE_LIMIT_EXCEEDED",
      "The npm lockfile contains too many dependency records.",
    );
  }
  const deduplicated = new Map<string, DependencyRecord>();
  for (const record of records) {
    const key = JSON.stringify([
      record.name,
      record.version,
      record.lockfilePath,
      record.importer,
      record.dependencyPath,
    ]);
    if (!deduplicated.has(key)) deduplicated.set(key, freezeRecord(record));
  }
  return Object.freeze([...deduplicated.values()].sort(compareRecords));
}

function parseV1(
  root: JsonNode,
  lockfilePath: string,
  lineAt: (offset: number) => number,
): DependencyInventory {
  const dependencies = property(root, "dependencies");
  if (dependencies === undefined) return Object.freeze([]);
  const records: DependencyRecord[] = [];
  const walk = (node: JsonNode, parents: readonly string[]): void => {
    for (const entry of properties(node, "dependencies")) {
      const name = packageName(entry.key);
      const versionNode = property(entry.valueNode, "version");
      const version = exactVersion(versionNode);
      const path = Object.freeze([...parents, name]);
      records.push({
        name,
        version,
        ecosystem: "npm",
        lockfilePath,
        line: lineAt((versionNode ?? entry.keyNode).offset),
        importer: ".",
        dependencyPath: path,
      });
      if (records.length > MAX_DEPENDENCY_RECORDS) {
        throw inventoryError(
          "LOCKFILE_LIMIT_EXCEEDED",
          "The npm lockfile contains too many dependency records.",
        );
      }
      const nested = property(entry.valueNode, "dependencies");
      if (nested !== undefined) walk(nested, path);
    }
  };
  walk(dependencies, []);
  return finalize(records);
}

function parseModern(
  root: JsonNode,
  lockfilePath: string,
  lineAt: (offset: number) => number,
): DependencyInventory {
  const packages = property(root, "packages");
  if (packages === undefined) invalid("The npm lockfile is missing its packages inventory.");
  const records: DependencyRecord[] = [];
  for (const entry of properties(packages, "packages")) {
    const context = dependencyPathFromPackageKey(entry.key);
    if (context === undefined || booleanValue(property(entry.valueNode, "link")) === true) {
      continue;
    }
    const versionNode = property(entry.valueNode, "version");
    const explicitName = stringValue(property(entry.valueNode, "name"));
    const installedName = context.dependencyPath.at(-1);
    const name = packageName(explicitName ?? installedName ?? "");
    records.push({
      name,
      version: exactVersion(versionNode),
      ecosystem: "npm",
      lockfilePath,
      line: lineAt((versionNode ?? entry.keyNode).offset),
      ...(context.importer === undefined ? {} : { importer: context.importer }),
      dependencyPath: context.dependencyPath,
    });
    if (records.length > MAX_DEPENDENCY_RECORDS) {
      throw inventoryError(
        "LOCKFILE_LIMIT_EXCEEDED",
        "The npm lockfile contains too many dependency records.",
      );
    }
  }
  return finalize(records);
}

export function parseNpmLockfile(
  contents: string,
  repositoryPath: string,
): DependencyInventory {
  let lockfilePath: string;
  try {
    lockfilePath = normalizeRepositoryRelativePath(repositoryPath);
  } catch {
    throw inventoryError(
      "LOCKFILE_NOT_DISCOVERED",
      "Zedbee refused an npm lockfile path outside the inspected snapshot.",
    );
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_LOCKFILE_BYTES) {
    throw inventoryError(
      "LOCKFILE_LIMIT_EXCEEDED",
      "The npm lockfile exceeds Zedbee's file-size safety limit.",
    );
  }
  const errors: ParseError[] = [];
  const root = parseTree(contents, errors, {
    allowTrailingComma: false,
    disallowComments: true,
  });
  if (root === undefined || errors.length > 0 || root.type !== "object") {
    throw inventoryError("LOCKFILE_INVALID", "Zedbee could not parse the npm lockfile.");
  }
  try {
    validateTree(root);
    const versionNode = property(root, "lockfileVersion");
    const version = versionNode?.type === "number" ? versionNode.value : undefined;
    if (version !== 1 && version !== 2 && version !== 3) {
      throw inventoryError(
        "LOCKFILE_VERSION_UNSUPPORTED",
        "The npm lockfile version is not supported by this Zedbee release.",
      );
    }
    const positions = createSourcePositionIndex(contents);
    return version === 1
      ? parseV1(root, lockfilePath, positions.lineAt)
      : parseModern(root, lockfilePath, positions.lineAt);
  } catch (error) {
    if (error instanceof LockfileInventoryError) throw error;
    throw inventoryError("LOCKFILE_INVALID", "The npm lockfile has invalid structure.");
  }
}
