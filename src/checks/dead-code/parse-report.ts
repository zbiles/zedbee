import { compareCodeUnits } from "../../core/compare.js";
import type { Observation } from "../../core/types.js";
import { normalizeRepositoryRelativePath } from "../../attribution/fingerprint.js";

const ISSUE_TYPES = [
  "files",
  "dependencies",
  "devDependencies",
  "unlisted",
  "unresolved",
  "exports",
  "types",
  "nsExports",
  "nsTypes",
  "duplicates",
] as const;

type IssueType = (typeof ISSUE_TYPES)[number];

function record(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`Expected ${field}`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`Expected canonical ${field}`);
  }
  return value;
}

function coordinate(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new TypeError("Expected Knip coordinate");
  }
  return value as number;
}

function message(type: IssueType): string {
  const messages: Record<IssueType, string> = {
    files: "File is unused.",
    dependencies: "Production dependency is unused.",
    devDependencies: "Development dependency is unused.",
    unlisted: "Imported dependency is not declared.",
    unresolved: "Import cannot be resolved.",
    exports: "Export is unused.",
    types: "Exported type is unused.",
    nsExports: "Namespace export is unused.",
    nsTypes: "Namespace type is unused.",
    duplicates: "Export is duplicated.",
  };
  return messages[type];
}

function itemObservations(
  type: IssueType,
  file: string,
  rawItems: unknown,
): readonly Observation[] {
  if (!Array.isArray(rawItems)) throw new TypeError("Expected Knip issue list");
  const groups =
    type === "duplicates" ? rawItems : rawItems.map((item) => [item]);
  return groups.map((rawGroup): Observation => {
    if (!Array.isArray(rawGroup) || rawGroup.length === 0) {
      throw new TypeError("Expected Knip issue group");
    }
    const items = rawGroup.map((item) => record(item, "Knip issue"));
    const names = items.map((item) => text(item.name, "Knip issue name"));
    const line = coordinate(items[0]?.line);
    const column = coordinate(items[0]?.col);
    return {
      check: "deadCode",
      rule: type,
      identity: `${type}:${file}:${[...names].sort(compareCodeUnits).join("|")}`,
      severity: "error",
      message: message(type),
      entity: {
        kind: `knip-${type}`,
        name: [...names].sort(compareCodeUnits).join("|"),
        file,
      },
      location: {
        file,
        ...(line === undefined ? {} : { startLine: line }),
        ...(column === undefined ? {} : { startColumn: column }),
      },
    };
  });
}

export function parseKnipReport(
  value: unknown,
  allowedFiles: ReadonlySet<string>,
): readonly Observation[] {
  const report = record(value, "Knip report");
  if (!Array.isArray(report.issues))
    throw new TypeError("Expected Knip issues");
  const observations: Observation[] = [];
  for (const rawRow of report.issues) {
    const row = record(rawRow, "Knip issue row");
    const file = normalizeRepositoryRelativePath(text(row.file, "Knip file"));
    if (!allowedFiles.has(file)) {
      throw new TypeError("Knip issue escaped inspected files");
    }
    for (const type of ISSUE_TYPES) {
      if (row[type] !== undefined) {
        observations.push(...itemObservations(type, file, row[type]));
      }
    }
  }
  const unique = new Map<string, Observation>();
  for (const observation of observations) {
    unique.set(`${observation.rule}:${observation.identity}`, observation);
  }
  return Object.freeze(
    [...unique.values()].sort((left, right) =>
      compareCodeUnits(left.identity, right.identity),
    ),
  );
}
