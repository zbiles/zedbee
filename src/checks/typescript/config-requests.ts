import { posix } from "node:path";
import {
  URL_SCHEME,
  WINDOWS_PATH as WINDOWS_DRIVE_PATH,
} from "../project/import-specifier.js";

/** A tsconfig `extends` value as a list, in declaration order. */
export function configExtensions(config: Record<string, unknown>): unknown[] {
  return config.extends === undefined
    ? []
    : Array.isArray(config.extends)
      ? config.extends
      : [config.extends];
}

/** The paths TypeScript tries, in order, for a relative extends/reference. */
export function tsconfigCandidates(base: string): string[] {
  return [base, `${base}.json`, posix.join(base, "tsconfig.json")];
}

/**
 * Shared safety + containment check for relative TypeScript requests, used
 * by both configuration parsing and compiler host resolution. A request is
 * rejected when it is empty, contains a backslash, carries a Windows drive
 * or URL scheme, is absolute, or normalizes outside the repository root.
 * Otherwise the helper returns the normalized repository-relative path.
 */
export function containedRelativeRequest(
  from: string,
  request: string,
): string | undefined {
  if (
    request.length === 0 ||
    request.includes("\\") ||
    WINDOWS_DRIVE_PATH.test(request) ||
    URL_SCHEME.test(request) ||
    posix.isAbsolute(request)
  ) {
    return undefined;
  }
  const path = posix.normalize(posix.join(posix.dirname(from), request));
  if (path === ".." || path.startsWith("../")) return undefined;
  return path;
}
