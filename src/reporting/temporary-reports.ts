import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { validateTemporaryReportPath } from "./report-path.js";

export type ReportMaintenanceWarningCode =
  "TEMP_REPORT_WRITE_FAILED" | "TEMP_REPORT_CLEANUP_FAILED";

export interface ReportMaintenanceWarning {
  readonly code: ReportMaintenanceWarningCode;
  readonly message: string;
  readonly path?: string;
}

export interface TemporaryReportRequest {
  readonly repositoryRoot: string;
  readonly maxAgeMs: number;
  readonly reportKind?: "scan-report" | "fix-plan";
  readonly json?: string;
}

export interface TemporaryReportResult {
  readonly reportPath?: string;
  readonly warnings: readonly ReportMaintenanceWarning[];
}

export interface TemporaryReportStore {
  maintain(request: TemporaryReportRequest): Promise<TemporaryReportResult>;
}

export interface TemporaryReportUserIdentity {
  readonly uid: number;
  readonly username: string;
}

interface ReportLifecycleState {
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

const STATE_FILE_NAME = ".lifecycle.json";
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_STATE_REPORTS = 10_000;
const LOCK_FILE_NAME = ".lifecycle.lock";
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const REPORT_NAME =
  /^zedbee-(?:scan-report|fix-plan)-[0-9]{14}(?:-[0-9]+)?\.json$/u;

function userNamespace(identity: TemporaryReportUserIdentity): string {
  if (Number.isSafeInteger(identity.uid) && identity.uid >= 0) {
    return `zedbee-u${identity.uid}`;
  }
  if (typeof identity.username !== "string" || identity.username.length === 0) {
    throw new TypeError("Unable to resolve temporary-report user identity");
  }
  return `zedbee-user-${createHash("sha256")
    .update(identity.username, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function reportTimestamp(nowMs: number): string {
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

function warning(
  code: ReportMaintenanceWarningCode,
  message: string,
  path?: string,
): ReportMaintenanceWarning {
  let validatedPath: string | undefined;
  if (path !== undefined) {
    try {
      validatedPath = validateTemporaryReportPath(path);
    } catch {
      validatedPath = undefined;
    }
  }
  return Object.freeze({
    code,
    message,
    ...(validatedPath === undefined ? {} : { path: validatedPath }),
  });
}

function result(
  warnings: ReportMaintenanceWarning[],
  reportPath?: string,
): TemporaryReportResult {
  return Object.freeze({
    ...(reportPath === undefined ? {} : { reportPath }),
    warnings: Object.freeze([...warnings]),
  });
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return "UNKNOWN";
}

async function ensureManagedDirectory(
  canonicalParent: string,
  name: string,
): Promise<string> {
  const path = join(canonicalParent, name);
  await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
    if (errorCode(error) !== "EEXIST") throw error;
  });
  const expected = await lstat(path);
  if (!expected.isDirectory() || expected.isSymbolicLink()) {
    throw new TypeError("Managed temporary-report boundary is not a directory");
  }
  const handle = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    const opened = await handle.stat();
    if (
      !opened.isDirectory() ||
      opened.dev !== expected.dev ||
      opened.ino !== expected.ino
    ) {
      throw new TypeError("Managed temporary-report boundary changed");
    }
    await handle.chmod(0o700);
    const canonicalPath = await realpath(path);
    const current = await lstat(path);
    if (
      current.isSymbolicLink() ||
      !current.isDirectory() ||
      current.dev !== opened.dev ||
      current.ino !== opened.ino ||
      dirname(canonicalPath) !== canonicalParent
    ) {
      throw new TypeError(
        "Managed temporary-report boundary escapes its parent",
      );
    }
    return canonicalPath;
  } finally {
    await handle.close();
  }
}

export async function syncTemporaryReportDirectory(
  directory: string,
  platform: NodeJS.Platform = process.platform,
): Promise<void> {
  if (platform === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicReplace(
  directory: string,
  destination: string,
  contents: string,
  warnings: ReportMaintenanceWarning[],
): Promise<void> {
  const temporary = join(directory, `.write-${randomUUID()}.tmp`);
  let handle: FileHandle | undefined = await open(temporary, "wx", 0o600);
  let renamed = false;
  try {
    await handle.chmod(0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, destination);
    renamed = true;
    await syncTemporaryReportDirectory(directory);
  } finally {
    await handle?.close().catch((error: unknown) => {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          `An atomic temporary file could not be closed (${errorCode(error)}).`,
        ),
      );
    });
    if (!renamed) {
      await unlink(temporary).catch((error: unknown) => {
        if (errorCode(error) !== "ENOENT") {
          warnings.push(
            warning(
              "TEMP_REPORT_CLEANUP_FAILED",
              `An atomic temporary file could not be removed (${errorCode(error)}).`,
            ),
          );
        }
      });
    }
  }
}

interface OwnedLock {
  readonly handle: FileHandle;
  readonly path: string;
  readonly device: number;
  readonly inode: number;
}

class LockTimeoutError extends Error {
  readonly code = "LOCK_TIMEOUT";

  constructor(
    message: string,
    readonly path?: string,
  ) {
    super(message);
  }
}

class StateLimitError extends Error {
  readonly code = "STATE_LIMIT";
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireLock(
  repositoryDirectory: string,
  warnings: ReportMaintenanceWarning[],
): Promise<OwnedLock> {
  const path = join(repositoryDirectory, LOCK_FILE_NAME);
  const deadline = performance.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const remaining = deadline - performance.now();
      if (remaining <= 0) {
        let actionablePath: string | undefined;
        try {
          const metadata = await lstat(path);
          if (metadata.isFile() && !metadata.isSymbolicLink()) {
            actionablePath = validateTemporaryReportPath(path);
          }
        } catch {
          actionablePath = undefined;
        }
        throw new LockTimeoutError(
          "Temporary-report lock timed out",
          actionablePath,
        );
      }
      await wait(Math.min(LOCK_RETRY_MS, remaining));
      continue;
    }
    let metadata;
    try {
      metadata = await handle.stat();
      await handle.chmod(0o600);
      await handle.sync();
      return {
        handle,
        path,
        device: metadata.dev,
        inode: metadata.ino,
      };
    } catch (error) {
      if (metadata !== undefined) {
        await releaseLock(
          {
            handle,
            path,
            device: metadata.dev,
            inode: metadata.ino,
          },
          warnings,
        );
      } else {
        await handle.close().catch((closeError: unknown) => {
          warnings.push(
            warning(
              "TEMP_REPORT_CLEANUP_FAILED",
              `A failed lock handle could not be closed (${errorCode(closeError)}).`,
            ),
          );
        });
      }
      throw error;
    }
  }
}

async function releaseLock(
  lock: OwnedLock,
  warnings: ReportMaintenanceWarning[],
): Promise<void> {
  try {
    let current;
    try {
      current = await lstat(lock.path);
    } catch (error) {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          `The owned temporary-report lock could not be validated (${errorCode(error)}).`,
        ),
      );
      return;
    }
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== lock.device ||
      current.ino !== lock.inode
    ) {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          "The owned temporary-report lock identity changed and was left untouched.",
        ),
      );
      return;
    }
    try {
      await unlink(lock.path);
    } catch (error) {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          `The validated temporary-report lock could not be removed (${errorCode(error)}).`,
          lock.path,
        ),
      );
      return;
    }
    try {
      await syncTemporaryReportDirectory(dirname(lock.path));
    } catch (error) {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          `The released lock directory could not be synchronized (${errorCode(error)}).`,
        ),
      );
    }
  } finally {
    await lock.handle.close().catch((error: unknown) => {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          `The owned temporary-report lock could not be closed (${errorCode(error)}).`,
        ),
      );
    });
  }
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

function serializeState(state: ReportLifecycleState): string {
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

async function readBoundedRegularFile(path: string): Promise<string> {
  const expected = await lstat(path);
  if (
    expected.isSymbolicLink() ||
    !expected.isFile() ||
    expected.size > MAX_STATE_BYTES
  ) {
    throw new TypeError("Invalid temporary-report lifecycle file");
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      metadata.size > MAX_STATE_BYTES ||
      metadata.dev !== expected.dev ||
      metadata.ino !== expected.ino
    ) {
      throw new TypeError("Invalid temporary-report lifecycle file");
    }
    const capacity = Math.min(metadata.size + 1, MAX_STATE_BYTES + 1);
    const buffer = Buffer.alloc(capacity);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        offset,
        buffer.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset > MAX_STATE_BYTES || offset > metadata.size) {
      throw new TypeError("Temporary-report lifecycle file changed while read");
    }
    return buffer.subarray(0, offset).toString("utf8");
  } finally {
    await handle.close();
  }
}

async function loadState(
  repositoryDirectory: string,
  warnings: ReportMaintenanceWarning[],
  nowMs: number,
): Promise<ReportLifecycleState> {
  try {
    const parsed = parseState(
      await readBoundedRegularFile(join(repositoryDirectory, STATE_FILE_NAME)),
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

async function rollbackReport(
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

async function writeUniqueReport(
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

async function removeExpiredReports(
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

export function createTemporaryReportStore(options?: {
  readonly temporaryRoot?: string;
  readonly userIdentity?: TemporaryReportUserIdentity;
  readonly now?: () => number;
}): TemporaryReportStore {
  const configuredTemporaryRoot = options?.temporaryRoot ?? tmpdir();
  const configuredUserIdentity = options?.userIdentity;
  const now = options?.now ?? Date.now;

  return Object.freeze({
    async maintain(
      request: TemporaryReportRequest,
    ): Promise<TemporaryReportResult> {
      const warnings: ReportMaintenanceWarning[] = [];
      let reportPath: string | undefined;
      let ownedLock: OwnedLock | undefined;
      try {
        if (!Number.isSafeInteger(request.maxAgeMs) || request.maxAgeMs < 0) {
          throw new TypeError("Invalid temporary-report maximum age");
        }
        const nowMs = now();
        if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
          throw new TypeError("Invalid temporary-report clock");
        }
        const [canonicalTemporaryRoot, canonicalRepositoryRoot] =
          await Promise.all([
            realpath(configuredTemporaryRoot),
            realpath(request.repositoryRoot),
          ]);
        const reportsRoot = await ensureManagedDirectory(
          canonicalTemporaryRoot,
          userNamespace(configuredUserIdentity ?? userInfo()),
        );
        const repositoryHash = createHash("sha256")
          .update(canonicalRepositoryRoot, "utf8")
          .digest("hex")
          .slice(0, 32);
        const repositoryDirectory = await ensureManagedDirectory(
          reportsRoot,
          repositoryHash,
        );
        ownedLock = await acquireLock(repositoryDirectory, warnings);
        const previousState = await loadState(
          repositoryDirectory,
          warnings,
          nowMs,
        );
        const reports = [
          ...(await removeExpiredReports(
            repositoryDirectory,
            previousState.reports,
            nowMs,
            request.maxAgeMs,
            warnings,
          )),
        ];

        if (request.json !== undefined) {
          const reportKind = request.reportKind ?? "scan-report";
          let hasCapacity = true;
          const capacityProbe: ReportLifecycleState = {
            schemaVersion: 2,
            reports: [
              ...reports,
              {
                fileName: `zedbee-${reportKind}-${reportTimestamp(nowMs)}.json`,
                createdAtMs: nowMs,
              },
            ],
          };
          try {
            serializeState(capacityProbe);
          } catch (error) {
            hasCapacity = false;
            warnings.push(
              warning(
                "TEMP_REPORT_WRITE_FAILED",
                `The temporary report could not be written (${errorCode(error)}).`,
              ),
            );
          }
          if (hasCapacity) {
            try {
              const report = await writeUniqueReport(
                repositoryDirectory,
                request.json,
                reportKind,
                nowMs,
                warnings,
              );
              reportPath = report.path;
              reports.push({
                fileName: report.fileName,
                createdAtMs: nowMs,
              });
            } catch (error) {
              warnings.push(
                warning(
                  "TEMP_REPORT_WRITE_FAILED",
                  `The temporary report could not be written (${errorCode(error)}).`,
                ),
              );
              reportPath = undefined;
            }
          }
        }

        const nextState: ReportLifecycleState = {
          schemaVersion: 2,
          reports,
        };
        try {
          await atomicReplace(
            repositoryDirectory,
            join(repositoryDirectory, STATE_FILE_NAME),
            serializeState(nextState),
            warnings,
          );
        } catch (error) {
          warnings.push(
            warning(
              "TEMP_REPORT_WRITE_FAILED",
              `Temporary-report lifecycle state could not be persisted (${errorCode(error)}).`,
            ),
          );
          if (reportPath !== undefined) {
            await rollbackReport(reportPath, warnings);
            reportPath = undefined;
          }
        }
      } catch (error) {
        warnings.push(
          warning(
            error instanceof LockTimeoutError || request.json === undefined
              ? "TEMP_REPORT_CLEANUP_FAILED"
              : "TEMP_REPORT_WRITE_FAILED",
            `Temporary-report maintenance could not start (${errorCode(error)}).`,
            error instanceof LockTimeoutError ? error.path : undefined,
          ),
        );
        reportPath = undefined;
      } finally {
        if (ownedLock !== undefined) {
          await releaseLock(ownedLock, warnings);
        }
      }
      return result(warnings, reportPath);
    },
  });
}
