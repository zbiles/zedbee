import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import {
  errorCode,
  result,
  warning,
  type ReportMaintenanceWarning,
  type TemporaryReportRequest,
  type TemporaryReportResult,
  type TemporaryReportStore,
  type TemporaryReportUserIdentity,
} from "./temporary-report-common.js";
import {
  atomicReplace,
  ensureManagedDirectory,
} from "./temporary-report-filesystem.js";
import {
  acquireLock,
  LockTimeoutError,
  releaseLock,
  type OwnedLock,
} from "./temporary-report-lock.js";
import {
  loadState,
  removeExpiredReports,
  reportTimestamp,
  rollbackReport,
  serializeState,
  STATE_FILE_NAME,
  writeUniqueReport,
  type ReportLifecycleState,
} from "./temporary-report-lifecycle.js";
export type {
  ReportMaintenanceWarningCode,
  ReportMaintenanceWarning,
  TemporaryReportRequest,
  TemporaryReportResult,
  TemporaryReportStore,
  TemporaryReportUserIdentity,
} from "./temporary-report-common.js";
export { syncTemporaryReportDirectory } from "./temporary-report-filesystem.js";

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

export function createTemporaryReportStore(options?: {
  readonly temporaryRoot?: string;
  readonly userIdentity?: TemporaryReportUserIdentity;
  readonly now?: () => number;
  readonly platform?: NodeJS.Platform;
}): TemporaryReportStore {
  const configuredTemporaryRoot = options?.temporaryRoot ?? tmpdir();
  const configuredUserIdentity = options?.userIdentity;
  const now = options?.now ?? Date.now;
  const platform = options?.platform ?? process.platform;

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
          platform,
        );
        // Isolate the kernel-lock protocol from older CLI writers that only use wx.
        const repositoryHash = createHash("sha256")
          .update("zedbee-temporary-reports:kernel-lock-v2\0", "utf8")
          .update(canonicalRepositoryRoot, "utf8")
          .digest("hex")
          .slice(0, 32);
        const repositoryDirectory = await ensureManagedDirectory(
          reportsRoot,
          repositoryHash,
          platform,
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
