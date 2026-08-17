import {
  isCollection,
  isNode,
  isPair,
  isScalar,
  parseDocument,
  type Node,
} from "yaml";
import { inventoryError } from "./errors.js";
import {
  MAX_DEPENDENCY_RECORDS,
  MAX_LOCKFILE_NESTING,
  MAX_LOCKFILE_NODES,
  MAX_LOCKFILE_STRING_LENGTH,
} from "./limits.js";
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

function validateYamlTree(root: Node | null): void {
  let count = 0;
  const visit = (node: Node | null, depth: number): void => {
    if (node === null) return;
    count += 1;
    if (count > MAX_LOCKFILE_NODES || depth > MAX_LOCKFILE_NESTING) {
      throw inventoryError("LOCKFILE_LIMIT_EXCEEDED", "The pnpm lockfile exceeds structural safety limits.");
    }
    if (isScalar(node) && typeof node.value === "string" && node.value.length > MAX_LOCKFILE_STRING_LENGTH) {
      throw inventoryError("LOCKFILE_LIMIT_EXCEEDED", "The pnpm lockfile contains an oversized string.");
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
    throw inventoryError("LOCKFILE_VERSION_MISSING", "The pnpm lockfile contains an ambiguous package key.");
  }
  return {
    name: validatePackageName(cleaned.slice(0, delimiter)),
    version: validateExactVersion(cleaned.slice(delimiter + 1)),
  };
}

function directContexts(data: Record<string, unknown>, format: "6.0" | "9.0") {
  const contexts = new Map<string, Array<{ importer: string; dependencyPath: readonly string[] }>>();
  const importers =
    format === "6.0"
      ? { ".": data }
      : plainRecord(data.importers ?? {}, "The pnpm lockfile importers must be an object.");
  for (const [importer, importerValue] of Object.entries(importers)) {
    const importerData = plainRecord(importerValue);
    for (const section of ["dependencies", "devDependencies", "optionalDependencies"] as const) {
      const dependencies = importerData[section];
      if (dependencies === undefined) continue;
      for (const [declaredName, rawValue] of Object.entries(plainRecord(dependencies))) {
        const dependency =
          typeof rawValue === "string"
            ? { version: rawValue }
            : plainRecord(rawValue);
        const rawVersion = dependency.version;
        if (typeof rawVersion !== "string" || rawVersion.startsWith("link:") || rawVersion.startsWith("workspace:")) continue;
        let resolvedName = declaredName;
        let version = rawVersion;
        if (rawVersion.startsWith("/")) {
          ({ name: resolvedName, version } = locatorPackage(rawVersion));
        } else {
          const specifier = dependency.specifier;
          if (typeof specifier === "string" && specifier.startsWith("npm:")) {
            const alias = locatorPackage(specifier.slice(4));
            resolvedName = alias.name;
          }
          version = validateExactVersion(rawVersion.replace(/\(.+\)$/u, ""));
        }
        const key = `${resolvedName}\0${version}`;
        const current = contexts.get(key) ?? [];
        current.push({ importer, dependencyPath: Object.freeze([validatePackageName(declaredName)]) });
        contexts.set(key, current);
      }
    }
  }
  return contexts;
}

export function parsePnpmLockfile(contents: string, repositoryPath: string): DependencyInventory {
  const lockfilePath = validateLockfileInput(contents, repositoryPath);
  const document = parseDocument(contents, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.contents === null) {
    throw inventoryError("LOCKFILE_INVALID", "Zedbee could not parse the pnpm lockfile.");
  }
  validateYamlTree(document.contents);
  let rawData: unknown;
  try {
    rawData = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw inventoryError("LOCKFILE_INVALID", "Zedbee could not safely read the pnpm lockfile structure.");
  }
  validateParsedStructure(rawData, "pnpm");
  const data = plainRecord(rawData);
  const format = data.lockfileVersion;
  if (format !== "6.0" && format !== "9.0") {
    throw inventoryError("LOCKFILE_VERSION_UNSUPPORTED", "The pnpm lockfile version is not supported by this Zedbee release.");
  }
  const packages = plainRecord(data.packages ?? {}, "The pnpm lockfile packages must be an object.");
  const positions = createSourcePositionIndex(contents);
  const contexts = directContexts(data, format);
  const records: DependencyRecord[] = [];
  for (const key of Object.keys(packages)) {
    const { name, version } = locatorPackage(key);
    const node = document.getIn(["packages", key], true) as Node | undefined;
    const line = node?.range == null ? undefined : positions.lineAt(node.range[0]);
    const matches = contexts.get(`${name}\0${version}`) ?? [];
    const scopes = matches.length === 0 ? [{ dependencyPath: Object.freeze([name]) }] : matches;
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
    if (records.length > MAX_DEPENDENCY_RECORDS) {
      throw inventoryError("LOCKFILE_LIMIT_EXCEEDED", "The pnpm lockfile contains too many dependency records.");
    }
  }
  return finalizeDependencyRecords(records);
}
