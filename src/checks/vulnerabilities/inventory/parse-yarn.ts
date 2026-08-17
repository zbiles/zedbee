import { parse as parseYarnClassic } from "@yarnpkg/lockfile";
import { isMap, isScalar, parseDocument, type Node } from "yaml";
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

function locatorName(descriptor: string): string {
  const npmAlias = descriptor.indexOf("@npm:");
  if (npmAlias > 0) {
    const actual = descriptor.slice(npmAlias + 5);
    const delimiter = actual.lastIndexOf("@");
    return validatePackageName(delimiter > 0 ? actual.slice(0, delimiter) : actual);
  }
  const delimiter = descriptor.lastIndexOf("@");
  if (delimiter <= 0) {
    throw inventoryError("LOCKFILE_INVALID", "The Yarn lockfile contains an ambiguous descriptor.");
  }
  return validatePackageName(descriptor.slice(0, delimiter));
}

function classicLineIndex(contents: string): ReadonlyMap<string, number> {
  const lines = contents.split(/\r?\n/u);
  const result = new Map<string, number>();
  lines.forEach((line, index) => {
    if (/^\s/u.test(line) || line.startsWith("#") || !line.endsWith(":")) return;
    const header = line.slice(0, -1);
    for (let selector of header.split(/,\s*/u)) {
      if (selector.startsWith('"') && selector.endsWith('"')) selector = selector.slice(1, -1);
      result.set(selector, index + 1);
    }
  });
  return result;
}

function parseClassic(contents: string, lockfilePath: string): DependencyInventory {
  let parsed;
  try {
    parsed = parseYarnClassic(contents, lockfilePath);
  } catch {
    throw inventoryError("LOCKFILE_INVALID", "Zedbee could not parse the Yarn Classic lockfile.");
  }
  if (parsed.type !== "success") {
    throw inventoryError("LOCKFILE_INVALID", "The Yarn Classic lockfile contains merge conflicts.");
  }
  validateParsedStructure(parsed.object, "Yarn Classic");
  const lines = classicLineIndex(contents);
  const records = Object.entries(parsed.object).map(([descriptor, raw]): DependencyRecord => {
    const entry = plainRecord(raw);
    const line = lines.get(descriptor);
    const name = locatorName(descriptor);
    return {
      name,
      version: validateExactVersion(entry.version),
      ecosystem: "npm",
      lockfilePath,
      ...(line === undefined ? {} : { line }),
      dependencyPath: Object.freeze([name]),
    };
  });
  return finalizeDependencyRecords(records);
}

function parseModern(contents: string, lockfilePath: string): DependencyInventory {
  const document = parseDocument(contents, { prettyErrors: false, strict: true, uniqueKeys: true });
  if (document.errors.length > 0 || document.contents === null) {
    throw inventoryError("LOCKFILE_INVALID", "Zedbee could not parse the Yarn Modern lockfile.");
  }
  let rawData: unknown;
  try {
    rawData = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw inventoryError("LOCKFILE_INVALID", "Zedbee could not safely read the Yarn Modern lockfile structure.");
  }
  validateParsedStructure(rawData, "Yarn Modern");
  const data = plainRecord(rawData);
  const metadata = plainRecord(data.__metadata, "The Yarn Modern lockfile is missing metadata.");
  if (typeof metadata.version !== "number" || metadata.version < 4 || metadata.version > 8) {
    throw inventoryError("LOCKFILE_VERSION_UNSUPPORTED", "The Yarn Modern lockfile version is not supported by this Zedbee release.");
  }
  const positions = createSourcePositionIndex(contents);
  const root = document.contents;
  const records: DependencyRecord[] = [];
  for (const [descriptor, raw] of Object.entries(data)) {
    if (descriptor === "__metadata") continue;
    const entry = plainRecord(raw);
    const resolution = entry.resolution;
    if (typeof resolution !== "string") {
      throw inventoryError("LOCKFILE_INVALID", "The Yarn Modern lockfile contains a package without a resolution.");
    }
    if (resolution.includes("@workspace:")) continue;
    const npmMarker = resolution.indexOf("@npm:");
    if (npmMarker <= 0) {
      throw inventoryError("LOCKFILE_INVALID", "The Yarn Modern lockfile contains an unsupported package resolution.");
    }
    const name = validatePackageName(resolution.slice(0, npmMarker));
    const pair = isMap(root)
      ? root.items.find(
          (item) => isScalar(item.key) && item.key.value === descriptor,
        )
      : undefined;
    const keyNode = pair?.key as Node | null | undefined;
    records.push({
      name,
      version: validateExactVersion(entry.version),
      ecosystem: "npm",
      lockfilePath,
      ...(keyNode?.range == null
        ? {}
        : { line: positions.lineAt(keyNode.range[0]) }),
      dependencyPath: Object.freeze([name]),
    });
  }
  return finalizeDependencyRecords(records);
}

export function parseYarnLockfile(contents: string, repositoryPath: string): DependencyInventory {
  const lockfilePath = validateLockfileInput(contents, repositoryPath);
  return /^#.*yarn lockfile v1/mu.test(contents)
    ? parseClassic(contents, lockfilePath)
    : parseModern(contents, lockfilePath);
}
