import { getNodeValue, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import { inventoryError } from "./errors.js";
import {
  finalizeDependencyRecords,
  plainRecord,
  validateDependencyRecordCount,
  validateExactVersion,
  validateLockfileInput,
  validatePackageName,
} from "./normalize.js";
import { createSourcePositionIndex } from "./source-position.js";
import type { DependencyInventory, DependencyRecord } from "./types.js";
import { validateParsedStructure } from "./validate-structure.js";

function locator(value: unknown): { name: string; version: string } | undefined {
  if (typeof value !== "string") {
    throw inventoryError("LOCKFILE_INVALID", "The Bun lockfile contains an invalid package locator.");
  }
  const delimiter = value.lastIndexOf("@");
  if (delimiter <= 0) {
    throw inventoryError("LOCKFILE_VERSION_MISSING", "The Bun lockfile contains an ambiguous package locator.");
  }
  const version = value.slice(delimiter + 1);
  if (version.startsWith("workspace:") || version.startsWith("link:")) return undefined;
  return {
    name: validatePackageName(value.slice(0, delimiter)),
    version: validateExactVersion(version),
  };
}

function dependencyPath(key: string): readonly string[] {
  const parts = key.split("/");
  const path = key.startsWith("@")
    ? [`${parts[0]}/${parts[1]}`, ...parts.slice(2)]
    : parts;
  path.forEach(validatePackageName);
  return Object.freeze(path);
}

function packageOffsets(root: JsonNode): ReadonlyMap<string, number> {
  const sectionProperty = root.children?.find((item) => item.children?.[0]?.value === "packages");
  const sectionNode = sectionProperty?.children?.[1];
  const offsets = new Map<string, number>();
  for (const property of sectionNode?.children ?? []) {
    const key: unknown = property.children?.[0]?.value;
    const value = property.children?.[1];
    // JSONC conversion uses the last duplicate value, but provenance has always
    // identified the first matching source property.
    if (typeof key === "string" && value !== undefined && !offsets.has(key)) {
      offsets.set(key, value.offset);
    }
  }
  return offsets;
}

export function parseBunLockfile(contents: string, repositoryPath: string): DependencyInventory {
  const lockfilePath = validateLockfileInput(contents, repositoryPath);
  const errors: ParseError[] = [];
  const root = parseTree(contents, errors, { allowTrailingComma: true, disallowComments: false });
  if (root === undefined || errors.length > 0 || root.type !== "object") {
    throw inventoryError("LOCKFILE_INVALID", "Zedbee could not parse the Bun text lockfile.");
  }
  const rawData = getNodeValue(root);
  validateParsedStructure(rawData, "Bun");
  const data = plainRecord(rawData);
  if (data.lockfileVersion !== 1) {
    throw inventoryError("LOCKFILE_VERSION_UNSUPPORTED", "The Bun text lockfile version is not supported by this Zedbee release.");
  }
  const packages = plainRecord(data.packages ?? {}, "The Bun lockfile packages must be an object.");
  const positions = createSourcePositionIndex(contents);
  const offsets = packageOffsets(root);
  const records: DependencyRecord[] = [];
  for (const [key, raw] of Object.entries(packages)) {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw inventoryError("LOCKFILE_INVALID", "The Bun lockfile contains an invalid package tuple.");
    }
    const resolved = locator(raw[0]);
    if (resolved === undefined) continue;
    const offset = offsets.get(key);
    records.push({
      ...resolved,
      ecosystem: "npm",
      lockfilePath,
      ...(offset === undefined ? {} : { line: positions.lineAt(offset) }),
      dependencyPath: dependencyPath(key),
    });
    validateDependencyRecordCount(records.length);
  }
  return finalizeDependencyRecords(records);
}
