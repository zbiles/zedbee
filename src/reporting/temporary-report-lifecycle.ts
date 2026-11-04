import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  open,
  readdir,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { validateTemporaryReportPath } from "./report-path.js";
import {
  errorCode,
  warning,
  type ReportMaintenanceWarning,
} from "./temporary-report-common.js";
import {
  readBoundedRegularFile,
  syncTemporaryReportDirectory,
} from "./temporary-report-filesystem.js";
import { LOCK_FILE_NAME } from "./temporary-report-lock.js";

export interface ReportLifecycleState {
  readonly schemaVersion: 2;
  readonly reports: readonly {
    readonly fileName: string;
    readonly createdAtMs: number;
  }[];
}

interface LegacyReportLifecycleState {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly reports: readonly {
    readonly fileName: string;
    readonly createdGeneration: number;
  }[];
}

type ParsedReportLifecycleState =
  ReportLifecycleState | LegacyReportLifecycleState;

export const STATE_FILE_NAME = ".lifecycle.json";
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_STATE_REPORTS = 10_000;
const REPORT_NAME =
  /^zedbee-(?:scan-report|fix-plan)-[0-9]{14}(?:-[0-9]+)?\.json$/u;

export function reportTimestamp(nowMs: number): string {
  const date = new Date(nowMs);
  const year = date.getFullYear();
  if (!Number.isInteger(year) || year < 0 || year > 9_999) {
    throw new TypeError("Invalid temporary-report clock");
  }
  return [
    String(year).padStart(4, "0"),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
    String(date.getHours()).padStart(2, "0"),
    String(date.getMinutes()).padStart(2, "0"),
    String(date.getSeconds()).padStart(2, "0"),
  ].join("");
}

class StateLimitError extends Error {
  readonly code = "STATE_LIMIT";
}

function parseState(serialized: string): ParsedReportLifecycleState {
  const value = JSON.parse(serialized) as Record<string, unknown> | null;
  if (value === null || typeof value !== "object") {
    throw new TypeError("Invalid temporary-report lifecycle state");
  }
  if (value.schemaVersion === 1) {
    if (
      !hasOnlyKeys(value, ["schemaVersion", "generation", "reports"]) ||
      !Number.isSafeInteger(value.generation) ||
      (value.generation as number) < 1 ||
      (value.generation as number) >= Number.MAX_SAFE_INTEGER ||
      !Array.isArray(value.reports) ||
      value.reports.length > MAX_STATE_REPORTS ||
      value.reports.some(
        (report) =>
          typeof report !== "object" ||
          report === null ||
          !hasOnlyKeys(report, ["fileName", "createdGeneration"]) ||
          typeof report.fileName !== "string" ||
          basename(report.fileName) !== report.fileName ||
          !REPORT_NAME.test(report.fileName) ||
          !Number.isSafeInteger(report.createdGeneration) ||
          report.createdGeneration < 1 ||
          report.createdGeneration > (value.generation as number),
      )
    ) {
      throw new TypeError("Invalid temporary-report lifecycle state");
    }
  } else if (value.schemaVersion === 2) {
    if (
      !hasOnlyKeys(value, ["schemaVersion", "reports"]) ||
      !Array.isArray(value.reports) ||
      value.reports.length > MAX_STATE_REPORTS ||
      value.reports.some(
        (report) =>
          typeof report !== "object" ||
          report === null ||
          !hasOnlyKeys(report, ["fileName", "createdAtMs"]) ||
          typeof report.fileName !== "string" ||
          basename(report.fileName) !== report.fileName ||
          !REPORT_NAME.test(report.fileName) ||
          !Number.isSafeInteger(report.createdAtMs) ||
          report.createdAtMs < 0,
      )
    ) {
      throw new TypeError("Invalid temporary-report lifecycle state");
    }
  } else {
    throw new TypeError("Invalid temporary-report lifecycle state");
  }
  const reports = value.reports as readonly { readonly fileName: string }[];
  if (
    new Set(reports.map((report) => report.fileName)).size !== reports.length
  ) {
    throw new TypeError("Duplicate temporary-report lifecycle entry");
  }
  return value as unknown as ParsedReportLifecycleState;
}

export function serializeState(state: ReportLifecycleState): string {
  if (state.reports.length > MAX_STATE_REPORTS) {
    throw new StateLimitError(
      "Temporary-report lifecycle record limit reached",
    );
  }
  const serialized = `${JSON.stringify(state)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_STATE_BYTES) {
    throw new StateLimitError("Temporary-report lifecycle byte limit reached");
  }
  return serialized;
}

function hasOnlyKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    expected.every((key) => Object.prototype.hasOwnProperty.call(value, key))
  );
}

export async function loadState(
  repositoryDirectory: string,
  warnings: ReportMaintenanceWarning[],
  nowMs: number,
): Promise<ReportLifecycleState> {
  try {
    const parsed = parseState(
      await readBoundedRegularFile(
        join(repositoryDirectory, STATE_FILE_NAME),
        MAX_STATE_BYTES,
      ),
    );
    if (parsed.schemaVersion === 2) return parsed;
    const reports: ReportLifecycleState["reports"][number][] = [];
    for (const report of parsed.reports) {
      const path = trackedReportPath(repositoryDirectory, report.fileName);
      let createdAtMs = nowMs;
      if (path !== undefined) {
        try {
          const metadata = await lstat(path);
          if (
            metadata.isFile() &&
            !metadata.isSymbolicLink() &&
            Number.isSafeInteger(metadata.mtimeMs) &&
            metadata.mtimeMs >= 0
          ) {
            createdAtMs = Math.min(metadata.mtimeMs, nowMs);
          }
        } catch {
          // Preserve the tracked entry with a fresh age; cleanup validates it later.
        }
      }
      reports.push({ fileName: report.fileName, createdAtMs });
    }
    return { schemaVersion: 2, reports };
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      const entries = await readdir(repositoryDirectory).catch(() => undefined);
      if (
        entries !== undefined &&
        entries.length === 1 &&
        entries[0] === LOCK_FILE_NAME
      ) {
        return { schemaVersion: 2, reports: [] };
      }
    }
    warnings.push(
      warning(
        "TEMP_REPORT_CLEANUP_FAILED",
        `Temporary-report lifecycle state was unavailable (${errorCode(error)}); unknown entries were left untouched.`,
      ),
    );
    return { schemaVersion: 2, reports: [] };
  }
}

export async function rollbackReport(
  reportPath: string,
  warnings: ReportMaintenanceWarning[],
): Promise<void> {
  try {
    const metadata = await lstat(reportPath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          "A newly written report changed type and was left untouched.",
        ),
      );
      return;
    }
  } catch (error) {
    warnings.push(
      warning(
        "TEMP_REPORT_CLEANUP_FAILED",
        `A newly written report could not be validated for rollback (${errorCode(error)}).`,
      ),
    );
    return;
  }
  try {
    await unlink(reportPath);
  } catch (error) {
    warnings.push(
      warning(
        "TEMP_REPORT_CLEANUP_FAILED",
        `A newly written report could not be rolled back (${errorCode(error)}).`,
        reportPath,
      ),
    );
    return;
  }
  try {
    await syncTemporaryReportDirectory(dirname(reportPath));
  } catch (error) {
    warnings.push(
      warning(
        "TEMP_REPORT_CLEANUP_FAILED",
        `A rolled-back report's directory could not be synchronized (${errorCode(error)}).`,
      ),
    );
  }
}

export async function writeUniqueReport(
  repositoryDirectory: string,
  json: string,
  reportKind: "scan-report" | "fix-plan",
  nowMs: number,
  warnings: ReportMaintenanceWarning[],
): Promise<{ readonly fileName: string; readonly path: string }> {
  const temporary = join(repositoryDirectory, `.report-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined = await open(temporary, "wx", 0o600);
  let publishedPath: string | undefined;
  let cleanupAttempted = false;
  try {
    await handle.chmod(0o600);
    await handle.writeFile(json, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;

    const stem = `zedbee-${reportKind}-${reportTimestamp(nowMs)}`;
    for (let attempt = 0; attempt < MAX_STATE_REPORTS; attempt += 1) {
      const fileName = `${stem}${attempt === 0 ? "" : `-${attempt + 1}`}.json`;
      const path = trackedReportPath(repositoryDirectory, fileName);
      if (path === undefined) {
        throw new TypeError("Invalid generated report name");
      }
      validateTemporaryReportPath(path);
      try {
        await link(temporary, path);
      } catch (error) {
        if (errorCode(error) === "EEXIST") continue;
        throw error;
      }
      publishedPath = path;
      await syncTemporaryReportDirectory(repositoryDirectory);
      cleanupAttempted = true;
      await removeReportTemporary(temporary, repositoryDirectory, warnings);
      return { fileName, path };
    }
    throw new Error("Unable to allocate a unique temporary-report name");
  } catch (error) {
    if (publishedPath !== undefined) {
      await rollbackReport(publishedPath, warnings);
    }
    throw error;
  } finally {
    await handle?.close().catch((closeError: unknown) => {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          `A report temporary file could not be closed (${errorCode(closeError)}).`,
        ),
      );
    });
    if (!cleanupAttempted) {
      await removeReportTemporary(temporary, repositoryDirectory, warnings);
    }
  }
}

async function removeReportTemporary(
  temporary: string,
  repositoryDirectory: string,
  warnings: ReportMaintenanceWarning[],
): Promise<void> {
  try {
    await unlink(temporary);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          `A report temporary file could not be removed (${errorCode(error)}).`,
        ),
      );
    }
    return;
  }
  try {
    await syncTemporaryReportDirectory(repositoryDirectory);
  } catch (error) {
    warnings.push(
      warning(
        "TEMP_REPORT_CLEANUP_FAILED",
        `A report temporary-file removal could not be synchronized (${errorCode(error)}).`,
      ),
    );
  }
}

function trackedReportPath(
  repositoryDirectory: string,
  fileName: string,
): string | undefined {
  if (basename(fileName) !== fileName || !REPORT_NAME.test(fileName)) {
    return undefined;
  }
  const path = resolve(repositoryDirectory, fileName);
  return dirname(path) === repositoryDirectory ? path : undefined;
}

export async function removeExpiredReports(
  repositoryDirectory: string,
  reports: ReportLifecycleState["reports"],
  nowMs: number,
  maxAgeMs: number,
  warnings: ReportMaintenanceWarning[],
): Promise<ReportLifecycleState["reports"]> {
  const retained: ReportLifecycleState["reports"][number][] = [];
  for (const report of reports) {
    if (nowMs - report.createdAtMs < maxAgeMs) {
      retained.push(report);
      continue;
    }
    const path = trackedReportPath(repositoryDirectory, report.fileName);
    if (path === undefined) {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          "An invalid lifecycle entry was ignored and no file was removed.",
        ),
      );
      continue;
    }
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") continue;
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          `A tracked report could not be validated and was left untouched (${errorCode(error)}).`,
        ),
      );
      retained.push(report);
      continue;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          "A tracked report was not a regular file and was left untouched.",
        ),
      );
      retained.push(report);
      continue;
    }
    try {
      await unlink(path);
    } catch (error) {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          `A validated tracked report could not be removed (${errorCode(error)}).`,
          path,
        ),
      );
      retained.push(report);
      continue;
    }
    try {
      await syncTemporaryReportDirectory(repositoryDirectory);
    } catch (error) {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          `A removed report's directory could not be synchronized (${errorCode(error)}).`,
        ),
      );
    }
  }
  return retained;
}
