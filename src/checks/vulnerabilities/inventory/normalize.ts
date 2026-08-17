import { normalizeRepositoryRelativePath } from "../../../attribution/fingerprint.js";
import { compareCodeUnits } from "../../../core/compare.js";
import { inventoryError } from "./errors.js";
import {
  MAX_DEPENDENCY_PATH_LENGTH,
  MAX_DEPENDENCY_RECORDS,
  MAX_LOCKFILE_BYTES,
  MAX_PACKAGE_NAME_LENGTH,
  MAX_PACKAGE_VERSION_LENGTH,
} from "./limits.js";
import type { DependencyInventory, DependencyRecord } from "./types.js";

export function validateLockfileInput(
  contents: string,
  repositoryPath: string,
): string {
  let lockfilePath: string;
  try {
    lockfilePath = normalizeRepositoryRelativePath(repositoryPath);
  } catch {
    throw inventoryError(
      "LOCKFILE_NOT_DISCOVERED",
      "Zedbee refused a lockfile path outside the inspected snapshot.",
    );
  }
  if (Buffer.byteLength(contents, "utf8") > MAX_LOCKFILE_BYTES) {
    throw inventoryError(
      "LOCKFILE_LIMIT_EXCEEDED",
      "The lockfile exceeds Zedbee's file-size safety limit.",
    );
  }
  return lockfilePath;
}

export function validatePackageName(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_PACKAGE_NAME_LENGTH ||
    /[\s\\]/u.test(value) ||
    value.startsWith(".") ||
    (value.startsWith("@")
      ? !/^@[^/]+\/[^/]+$/u.test(value)
      : value.includes("/"))
  ) {
    throw inventoryError(
      typeof value === "string" && value.length > MAX_PACKAGE_NAME_LENGTH
        ? "LOCKFILE_LIMIT_EXCEEDED"
        : "LOCKFILE_INVALID",
      "The lockfile contains an invalid package name.",
    );
  }
  return value;
}

export function validateExactVersion(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw inventoryError(
      "LOCKFILE_VERSION_MISSING",
      "The lockfile contains a package without an exact version.",
    );
  }
  if (value.length > MAX_PACKAGE_VERSION_LENGTH) {
    throw inventoryError(
      "LOCKFILE_LIMIT_EXCEEDED",
      "The lockfile contains an oversized package version.",
    );
  }
  if (/[\s|]/u.test(value) || /^[~^<>=*]/u.test(value)) {
    throw inventoryError(
      "LOCKFILE_VERSION_INVALID",
      "The lockfile contains a package version that is not exact.",
    );
  }
  return value;
}

export function finalizeDependencyRecords(
  records: readonly DependencyRecord[],
): DependencyInventory {
  if (records.length > MAX_DEPENDENCY_RECORDS) {
    throw inventoryError(
      "LOCKFILE_LIMIT_EXCEEDED",
      "The lockfile contains too many dependency records.",
    );
  }
  const deduplicated = new Map<string, DependencyRecord>();
  for (const candidate of records) {
    const name = validatePackageName(candidate.name);
    const version = validateExactVersion(candidate.version);
    const dependencyPath = candidate.dependencyPath;
    if (
      dependencyPath !== undefined &&
      dependencyPath.length > MAX_DEPENDENCY_PATH_LENGTH
    ) {
      throw inventoryError(
        "LOCKFILE_LIMIT_EXCEEDED",
        "The lockfile contains an oversized dependency path.",
      );
    }
    dependencyPath?.forEach(validatePackageName);
    const record = Object.freeze({
      ...candidate,
      name,
      version,
      ...(dependencyPath === undefined
        ? {}
        : { dependencyPath: Object.freeze([...dependencyPath]) }),
    });
    const key = JSON.stringify([
      record.name,
      record.version,
      record.lockfilePath,
      record.importer,
      record.dependencyPath,
    ]);
    if (!deduplicated.has(key)) deduplicated.set(key, record);
  }
  return Object.freeze(
    [...deduplicated.values()].sort(
      (left, right) =>
        compareCodeUnits(left.name, right.name) ||
        compareCodeUnits(left.version, right.version) ||
        compareCodeUnits(left.importer ?? "", right.importer ?? "") ||
        compareCodeUnits(
          left.dependencyPath?.join("\0") ?? "",
          right.dependencyPath?.join("\0") ?? "",
        ) ||
        (left.line ?? 0) - (right.line ?? 0),
    ),
  );
}

export function plainRecord(
  value: unknown,
  message = "The lockfile has invalid structure.",
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw inventoryError("LOCKFILE_INVALID", message);
  }
  return value as Record<string, unknown>;
}
