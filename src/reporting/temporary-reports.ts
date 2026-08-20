import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  link,
  lstat,
  mkdir,
  open,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

export type ReportMaintenanceWarningCode =
  "TEMP_REPORT_WRITE_FAILED" | "TEMP_REPORT_CLEANUP_FAILED";

export interface ReportMaintenanceWarning {
  readonly code: ReportMaintenanceWarningCode;
  readonly message: string;
  readonly path?: string;
}

export interface TemporaryReportRequest {
  readonly repositoryRoot: string;
  readonly retentionRuns: number;
  readonly json?: string;
}

export interface TemporaryReportResult {
  readonly reportPath?: string;
  readonly warnings: readonly ReportMaintenanceWarning[];
}

export interface TemporaryReportStore {
  maintain(request: TemporaryReportRequest): Promise<TemporaryReportResult>;
}

interface ReportLifecycleState {
  readonly schemaVersion: 1;
  readonly generation: number;
  readonly reports: readonly {
    readonly fileName: string;
    readonly createdGeneration: number;
  }[];
}

const STATE_FILE_NAME = ".lifecycle.json";
const MAX_STATE_BYTES = 1024 * 1024;
const MAX_STATE_REPORTS = 10_000;
const LOCK_FILE_NAME = ".lifecycle.lock";
const LOCK_TIMEOUT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const REPORT_NAME =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.json$/u;

function warning(
  code: ReportMaintenanceWarningCode,
  message: string,
  path?: string,
): ReportMaintenanceWarning {
  return Object.freeze({
    code,
    message,
    ...(path === undefined ? {} : { path }),
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
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    let handle: FileHandle;
    try {
      handle = await open(path, "wx", 0o600);
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new LockTimeoutError("Temporary-report lock timed out");
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
    const current = await lstat(lock.path);
    if (
      current.isSymbolicLink() ||
      !current.isFile() ||
      current.dev !== lock.device ||
      current.ino !== lock.inode
    ) {
      throw new TypeError("Temporary-report lock identity changed");
    }
    await unlink(lock.path);
    await syncTemporaryReportDirectory(dirname(lock.path));
  } catch (error) {
    warnings.push(
      warning(
        "TEMP_REPORT_CLEANUP_FAILED",
        `The owned temporary-report lock could not be released safely (${errorCode(error)}).`,
      ),
    );
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

function parseState(serialized: string): ReportLifecycleState {
  const value = JSON.parse(serialized) as Partial<ReportLifecycleState> | null;
  if (
    value === null ||
    typeof value !== "object" ||
    !hasOnlyKeys(value, ["schemaVersion", "generation", "reports"]) ||
    value.schemaVersion !== 1 ||
    !Number.isSafeInteger(value.generation) ||
    value.generation === undefined ||
    value.generation < 1 ||
    value.generation >= Number.MAX_SAFE_INTEGER ||
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
        report.createdGeneration > value.generation!,
    )
  ) {
    throw new TypeError("Invalid temporary-report lifecycle state");
  }
  if (
    new Set(value.reports.map((report) => report.fileName)).size !==
    value.reports.length
  ) {
    throw new TypeError("Duplicate temporary-report lifecycle entry");
  }
  return value as ReportLifecycleState;
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
): Promise<ReportLifecycleState> {
  try {
    return parseState(
      await readBoundedRegularFile(join(repositoryDirectory, STATE_FILE_NAME)),
    );
  } catch (error) {
    warnings.push(
      warning(
        "TEMP_REPORT_CLEANUP_FAILED",
        `Temporary-report lifecycle state was unavailable (${errorCode(error)}); unknown entries were left untouched.`,
      ),
    );
    return { schemaVersion: 1, generation: 0, reports: [] };
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
    await syncTemporaryReportDirectory(dirname(reportPath));
  } catch (error) {
    warnings.push(
      warning(
        "TEMP_REPORT_CLEANUP_FAILED",
        `A newly written report could not be rolled back (${errorCode(error)}).`,
        reportPath,
      ),
    );
  }
}

async function writeUniqueReport(
  repositoryDirectory: string,
  json: string,
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

    for (let attempt = 0; attempt < 16; attempt += 1) {
      const fileName = `${randomUUID()}.json`;
      const path = trackedReportPath(repositoryDirectory, fileName);
      if (path === undefined) {
        throw new TypeError("Invalid generated report name");
      }
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
  generation: number,
  retentionRuns: number,
  warnings: ReportMaintenanceWarning[],
): Promise<ReportLifecycleState["reports"]> {
  const retained: ReportLifecycleState["reports"][number][] = [];
  for (const report of reports) {
    if (generation - report.createdGeneration < retentionRuns) {
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
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          `A tracked report could not be validated and was left untouched (${errorCode(error)}).`,
        ),
      );
      continue;
    }
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      warnings.push(
        warning(
          "TEMP_REPORT_CLEANUP_FAILED",
          "A tracked report was not a regular file and was left untouched.",
        ),
      );
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
          path,
        ),
      );
    }
  }
  return retained;
}

export function createTemporaryReportStore(options?: {
  readonly temporaryRoot?: string;
}): TemporaryReportStore {
  const configuredTemporaryRoot = options?.temporaryRoot ?? tmpdir();

  return Object.freeze({
    async maintain(
      request: TemporaryReportRequest,
    ): Promise<TemporaryReportResult> {
      const warnings: ReportMaintenanceWarning[] = [];
      let reportPath: string | undefined;
      let ownedLock: OwnedLock | undefined;
      try {
        if (
          !Number.isSafeInteger(request.retentionRuns) ||
          request.retentionRuns < 1
        ) {
          throw new TypeError("Invalid temporary-report retention");
        }
        const [canonicalTemporaryRoot, canonicalRepositoryRoot] =
          await Promise.all([
            realpath(configuredTemporaryRoot),
            realpath(request.repositoryRoot),
          ]);
        const reportsRoot = await ensureManagedDirectory(
          canonicalTemporaryRoot,
          "zedbee-reports",
        );
        const repositoryHash = createHash("sha256")
          .update(canonicalRepositoryRoot, "utf8")
          .digest("hex");
        const repositoryDirectory = await ensureManagedDirectory(
          reportsRoot,
          repositoryHash,
        );
        ownedLock = await acquireLock(repositoryDirectory, warnings);
        const previousState = await loadState(repositoryDirectory, warnings);
        const generation = previousState.generation + 1;
        const reports = [
          ...(await removeExpiredReports(
            repositoryDirectory,
            previousState.reports,
            generation,
            request.retentionRuns,
            warnings,
          )),
        ];

        if (request.json !== undefined) {
          let hasCapacity = true;
          const capacityProbe: ReportLifecycleState = {
            schemaVersion: 1,
            generation,
            reports: [
              ...reports,
              {
                fileName: "00000000-0000-4000-8000-000000000000.json",
                createdGeneration: generation,
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
                warnings,
              );
              reportPath = report.path;
              reports.push({
                fileName: report.fileName,
                createdGeneration: generation,
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
          schemaVersion: 1,
          generation,
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
