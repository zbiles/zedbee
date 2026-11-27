import { parseDocument } from "yaml";
import { inventoryError } from "./errors.js";
import { validateParsedStructure } from "./validate-structure.js";

export type YamlLockfileDocument = ReturnType<typeof parseDocument>;

export function parseYamlLockfileDocument(
  contents: string,
  formatLabel: string,
): YamlLockfileDocument {
  const document = parseDocument(contents, {
    prettyErrors: false,
    strict: true,
    uniqueKeys: true,
  });
  if (document.errors.length > 0 || document.contents === null) {
    throw inventoryError(
      "LOCKFILE_INVALID",
      `Zedbee could not parse the ${formatLabel} lockfile.`,
    );
  }
  return document;
}

export function readYamlLockfileData(
  document: YamlLockfileDocument,
  formatLabel: string,
): unknown {
  let rawData: unknown;
  try {
    rawData = document.toJS({ maxAliasCount: 0 });
  } catch {
    throw inventoryError(
      "LOCKFILE_INVALID",
      `Zedbee could not safely read the ${formatLabel} lockfile structure.`,
    );
  }
  validateParsedStructure(rawData, formatLabel);
  return rawData;
}
