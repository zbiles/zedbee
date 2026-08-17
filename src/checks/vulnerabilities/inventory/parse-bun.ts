import { getNodeValue, parseTree, type Node as JsonNode, type ParseError } from "jsonc-parser";
import { inventoryError } from "./errors.js";
import {
  finalizeDependencyRecords,
  plainRecord,
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

function propertyNode(root: JsonNode, section: string, key: string): JsonNode | undefined {
  const sectionProperty = root.children?.find((item) => item.children?.[0]?.value === section);
  const sectionNode = sectionProperty?.children?.[1];
  const property = sectionNode?.children?.find((item) => item.children?.[0]?.value === key);
  return property?.children?.[1];
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
  const records: DependencyRecord[] = [];
  for (const [key, raw] of Object.entries(packages)) {
    if (!Array.isArray(raw) || raw.length === 0) {
      throw inventoryError("LOCKFILE_INVALID", "The Bun lockfile contains an invalid package tuple.");
    }
    const resolved = locator(raw[0]);
    if (resolved === undefined) continue;
    const node = propertyNode(root, "packages", key);
    records.push({
      ...resolved,
      ecosystem: "npm",
      lockfilePath,
      ...(node === undefined ? {} : { line: positions.lineAt(node.offset) }),
      dependencyPath: dependencyPath(key),
    });
  }
  return finalizeDependencyRecords(records);
}
