import { isCollection, isMap, isNode, isPair, isScalar, type Node } from "yaml";
import { inventoryError } from "./errors.js";
import {
  MAX_LOCKFILE_NESTING,
  MAX_LOCKFILE_NODES,
  MAX_LOCKFILE_STRING_LENGTH,
} from "./limits.js";
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
import {
  parseYamlLockfileDocument,
  readYamlLockfileData,
  type YamlLockfileDocument,
} from "./yaml-document.js";

function validateYamlTree(root: Node | null): void {
  let count = 0;
  const visit = (node: Node | null, depth: number): void => {
    if (node === null) return;
    count += 1;
    if (count > MAX_LOCKFILE_NODES || depth > MAX_LOCKFILE_NESTING) {
      throw inventoryError(
        "LOCKFILE_LIMIT_EXCEEDED",
        "The pnpm lockfile exceeds structural safety limits.",
      );
    }
    if (
      isScalar(node) &&
      typeof node.value === "string" &&
      node.value.length > MAX_LOCKFILE_STRING_LENGTH
    ) {
      throw inventoryError(
        "LOCKFILE_LIMIT_EXCEEDED",
        "The pnpm lockfile contains an oversized string.",
      );
    }
    if (isCollection(node)) {
      for (const item of node.items) {
        if (isPair(item)) {
          visit(item.key as Node | null, depth + 1);
          visit(item.value as Node | null, depth + 1);
        } else if (isNode(item)) visit(item, depth + 1);
      }
    }
  };
  visit(root, 1);
}

function locatorPackage(value: string): { name: string; version: string } {
  const cleaned = value.replace(/^\//u, "").replace(/\(.+\)$/u, "");
  const delimiter = cleaned.lastIndexOf("@");
  if (delimiter <= 0 || delimiter === cleaned.length - 1) {
    throw inventoryError(
      "LOCKFILE_VERSION_MISSING",
      "The pnpm lockfile contains an ambiguous package key.",
    );
  }
  return {
    name: validatePackageName(cleaned.slice(0, delimiter)),
    version: validateExactVersion(cleaned.slice(delimiter + 1)),
  };
}

function directDependency(
  declaredName: string,
  rawValue: unknown,
): { readonly name: string; readonly version: string } | undefined {
  const dependency =
    typeof rawValue === "string"
      ? { version: rawValue }
      : plainRecord(rawValue);
  const rawVersion = dependency.version;
  if (
    typeof rawVersion !== "string" ||
    rawVersion.startsWith("link:") ||
    rawVersion.startsWith("workspace:")
  )
    return undefined;
  if (rawVersion.startsWith("/")) return locatorPackage(rawVersion);
  const version = rawVersion.replace(/\(.+\)$/u, "");
  const specifier = dependency.specifier;
  if (typeof specifier !== "string" || !specifier.startsWith("npm:")) {
    return { name: declaredName, version: validateExactVersion(version) };
  }
  // pnpm 9 records an aliased dependency's version as "<real-name>@<version>".
  if (version.lastIndexOf("@") > 0) return locatorPackage(version);
  return {
    name: locatorPackage(specifier.slice(4)).name,
    version: validateExactVersion(version),
  };
}

function directContexts(data: Record<string, unknown>, format: "6.0" | "9.0") {
  const contexts = new Map<
    string,
    Array<{ importer: string; dependencyPath: readonly string[] }>
  >();
  const importers =
    format === "6.0"
      ? { ".": data }
      : plainRecord(
          data.importers ?? {},
          "The pnpm lockfile importers must be an object.",
        );
  for (const [importer, importerValue] of Object.entries(importers)) {
    const importerData = plainRecord(importerValue);
    for (const section of [
      "dependencies",
      "devDependencies",
      "optionalDependencies",
    ] as const) {
      const dependencies = importerData[section];
      if (dependencies === undefined) continue;
      for (const [declaredName, rawValue] of Object.entries(
        plainRecord(dependencies),
      )) {
        const resolved = directDependency(declaredName, rawValue);
        if (resolved === undefined) continue;
        const key = `${resolved.name}\0${resolved.version}`;
        const current = contexts.get(key) ?? [];
        current.push({
          importer,
          dependencyPath: Object.freeze([validatePackageName(declaredName)]),
        });
        contexts.set(key, current);
      }
    }
  }
  return contexts;
}

function packageValueOffsets(
  document: YamlLockfileDocument,
): ReadonlyMap<string, number> {
  const offsets = new Map<string, number>();
  const packages = document.get("packages", true);
  if (!isMap(packages)) return offsets;
  for (const pair of packages.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== "string") continue;
    if (offsets.has(pair.key.value)) continue;
    const value = pair.value;
    if (isNode(value) && value.range != null)
      offsets.set(pair.key.value, value.range[0]);
  }
  return offsets;
}

export function parsePnpmLockfile(
  contents: string,
  repositoryPath: string,
): DependencyInventory {
  const lockfilePath = validateLockfileInput(contents, repositoryPath);
  const document = parseYamlLockfileDocument(contents, "pnpm");
  validateYamlTree(document.contents);
  const rawData = readYamlLockfileData(document, "pnpm");
  const data = plainRecord(rawData);
  const format = data.lockfileVersion;
  if (format !== "6.0" && format !== "9.0") {
    throw inventoryError(
      "LOCKFILE_VERSION_UNSUPPORTED",
      "The pnpm lockfile version is not supported by this Zedbee release.",
    );
  }
  const packages = plainRecord(
    data.packages ?? {},
    "The pnpm lockfile packages must be an object.",
  );
  const positions = createSourcePositionIndex(contents);
  const offsets = packageValueOffsets(document);
  const contexts = directContexts(data, format);
  const records: DependencyRecord[] = [];
  for (const key of Object.keys(packages)) {
    const { name, version } = locatorPackage(key);
    const offset = offsets.get(key);
    const line = offset === undefined ? undefined : positions.lineAt(offset);
    const matches = contexts.get(`${name}\0${version}`) ?? [];
    const scopes =
      matches.length === 0
        ? [{ dependencyPath: Object.freeze([name]) }]
        : matches;
    for (const scope of scopes) {
      records.push({
        name,
        version,
        ecosystem: "npm",
        lockfilePath,
        ...(line === undefined ? {} : { line }),
        ...scope,
      });
    }
    validateDependencyRecordCount(records.length, "pnpm");
  }
  return finalizeDependencyRecords(records);
}
