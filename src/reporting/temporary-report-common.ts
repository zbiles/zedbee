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

export function warning(
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

export function result(
  warnings: ReportMaintenanceWarning[],
  reportPath?: string,
): TemporaryReportResult {
  return Object.freeze({
    ...(reportPath === undefined ? {} : { reportPath }),
    warnings: Object.freeze([...warnings]),
  });
}

export function errorCode(error: unknown): string {
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
