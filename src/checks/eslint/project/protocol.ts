import { posix } from "node:path";
import {
  ProjectEslintFailureError,
  type ProjectEslintResult,
} from "./types.js";

export const PROJECT_ESLINT_MAX_BYTES = 1024 * 1024;
export const PROJECT_ESLINT_MAX_FILES = 20_000;
export function validProjectEslintPath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 4096 &&
    !/[\\\x00-\x1f\x7f]/u.test(value) &&
    !value.startsWith("/") &&
    !/^[A-Za-z]:/u.test(value) &&
    value !== "." &&
    value !== ".." &&
    !value.split("/").includes("..") &&
    posix.normalize(value) === value &&
    /\.(?:[jt]sx?|[cm][jt]s)$/u.test(value) &&
    !value.split("/").includes("node_modules")
  );
}
export function parseProjectEslintResult(
  value: unknown,
  requestedFiles: readonly string[],
): ProjectEslintResult {
  const invalid = (): never => {
    throw new ProjectEslintFailureError("PROJECT_ESLINT_PROTOCOL_INVALID");
  };
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return invalid();
  const result = value as Record<string, unknown>;
  if (
    result.version !== "9.39.5" ||
    !Array.isArray(result.diagnostics) ||
    !Array.isArray(result.checkedFiles) ||
    !Array.isArray(result.ignoredFiles)
  )
    return invalid();
  const requested = new Set(requestedFiles),
    covered = new Set<string>();
  for (const file of [...result.checkedFiles, ...result.ignoredFiles]) {
    if (
      !validProjectEslintPath(file) ||
      !requested.has(file) ||
      covered.has(file)
    )
      return invalid();
    covered.add(file);
  }
  if (covered.size !== requested.size || result.diagnostics.length > 10_000)
    return invalid();
  const checked = new Set(result.checkedFiles);
  for (const raw of result.diagnostics) {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw))
      return invalid();
    const d = raw as Record<string, unknown>;
    if (
      typeof d.file !== "string" ||
      !checked.has(d.file) ||
      ![1, 2].includes(d.severity as number) ||
      typeof d.message !== "string" ||
      d.message.length > 64_000 ||
      (d.ruleId !== null &&
        (typeof d.ruleId !== "string" ||
          !/^[a-zA-Z0-9_@./-]{1,256}$/u.test(d.ruleId)))
    )
      return invalid();
    for (const key of ["line", "column", "endLine", "endColumn"])
      if (
        d[key] !== undefined &&
        (!Number.isSafeInteger(d[key]) || (d[key] as number) < 1)
      )
        return invalid();
    if (d.fatal !== undefined && typeof d.fatal !== "boolean") return invalid();
    if (
      d.comparisonIdentity !== undefined &&
      (typeof d.comparisonIdentity !== "string" ||
        !/^[a-f0-9]{64}$/u.test(d.comparisonIdentity))
    )
      return invalid();
  }
  // Copy only protocol-owned fields; project code cannot attach arbitrary payloads.
  return {
    version: "9.39.5",
    messages: "redacted",
    checkedFiles: result.checkedFiles as string[],
    ignoredFiles: result.ignoredFiles as string[],
    diagnostics: result.diagnostics.map((raw: Record<string, unknown>) => ({
      file: raw.file as string,
      ruleId: raw.ruleId as string | null,
      severity: raw.severity as 1 | 2,
      message: raw.message as string,
      ...Object.fromEntries(
        [
          "line",
          "column",
          "endLine",
          "endColumn",
          "fatal",
          "comparisonIdentity",
        ]
          .filter((key) => raw[key] !== undefined)
          .map((key) => [key, raw[key]]),
      ),
    })),
  };
}
