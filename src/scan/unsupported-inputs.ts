import { posix } from "node:path";
import {
  CHECK_IDS,
  type CheckId,
  type ResolvedConfig,
} from "../config/schema.js";
import { compareCodeUnits } from "../core/compare.js";
import type { UnsupportedIndexEntry } from "../git/snapshot.js";
import type { ScanFailureInput } from "./incomplete-report.js";

const SOURCE_EXTENSIONS = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);
const TYPESCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);
const FORMATTING_EXTENSIONS = new Set([
  ...SOURCE_EXTENSIONS,
  ".css",
  ".json",
  ".jsonc",
  ".md",
  ".markdown",
  ".yaml",
  ".yml",
]);
const SOURCE_CHECKS = new Set<CheckId>([
  "lint",
  "cyclomaticComplexity",
  "readabilityComplexity",
  "structuralSecurity",
  "duplication",
  "dependencyArchitecture",
  "deadCode",
  "reactCorrectness",
  "reactAccessibility",
]);
const LOCKFILE_NAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
]);

function checkMayBeEnabled(config: ResolvedConfig, checkId: CheckId): boolean {
  return (
    config.checks[checkId].severity !== "off" ||
    config.overrides.some((override) => {
      const severity = override.checks[checkId]?.severity;
      return severity !== undefined && severity !== "off";
    })
  );
}

function binaryPathRelevant(path: string, config: ResolvedConfig): boolean {
  const extension = posix.extname(path).toLowerCase();
  if (
    FORMATTING_EXTENSIONS.has(extension) &&
    checkMayBeEnabled(config, "formatting")
  ) {
    return true;
  }
  if (
    SOURCE_EXTENSIONS.has(extension) &&
    [...SOURCE_CHECKS].some((checkId) => checkMayBeEnabled(config, checkId))
  ) {
    return true;
  }
  if (
    TYPESCRIPT_EXTENSIONS.has(extension) &&
    checkMayBeEnabled(config, "types")
  ) {
    return true;
  }
  return (
    LOCKFILE_NAMES.has(posix.basename(path)) &&
    checkMayBeEnabled(config, "vulnerabilities")
  );
}

export function unsupportedEntryFailures(
  entries: readonly UnsupportedIndexEntry[],
  config: ResolvedConfig,
  changedPaths: ReadonlySet<string>,
): readonly ScanFailureInput[] {
  const anyCheckEnabled = CHECK_IDS.some((checkId) =>
    checkMayBeEnabled(config, checkId),
  );
  return [...entries]
    .filter((entry) => changedPaths.has(entry.path))
    .sort(
      (left, right) =>
        compareCodeUnits(left.path, right.path) ||
        compareCodeUnits(left.kind, right.kind),
    )
    .flatMap((entry): readonly ScanFailureInput[] => {
      if (entry.kind === "git-lfs-pointer") {
        return [
          {
            code: "GIT_LFS_POINTER",
            message: "Zedbee cannot inspect a staged Git LFS pointer.",
            path: entry.path,
            remediation:
              "Materialize the Git LFS object for this path, stage it again, and rerun the scan.",
          },
        ];
      }
      if (entry.kind === "submodule" && anyCheckEnabled) {
        return [
          {
            code: "GIT_SUBMODULE_UNAVAILABLE",
            message: "Zedbee cannot inspect a staged Git submodule pointer.",
            path: entry.path,
            remediation:
              "Validate the referenced submodule commit separately or remove the submodule change from this commit, then rerun the scan.",
          },
        ];
      }
      if (entry.kind === "binary" && binaryPathRelevant(entry.path, config)) {
        return [
          {
            code: "UNSUPPORTED_BINARY_INPUT",
            message:
              "Zedbee cannot analyze this staged binary file with the enabled checks.",
            path: entry.path,
            remediation:
              "Stage valid text at this path or remove it from the staged change, then rerun the scan.",
          },
        ];
      }
      return [];
    });
}
