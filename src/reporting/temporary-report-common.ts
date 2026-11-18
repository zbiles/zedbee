import { validateTemporaryReportPath } from "./report-path.js";

export type ReportMaintenanceWarningCode =
  "TEMP_REPORT_WRITE_FAILED" | "TEMP_REPORT_CLEANUP_FAILED";

export interface ReportMaintenanceWarning {
  readonly code: ReportMaintenanceWarningCode;
  readonly message: string;
  readonly path?: string;
}

/** Bounded, source-free local observations; never report contents, names, or paths. */
export interface ReportMaintenanceDiagnostics {
  readonly schemaVersion: 1;
  readonly protocolVersion: 2;
  readonly effectiveMaxAgeMs: number;
  removedExpired: number;
  alreadyMissing: number;
  state: "unavailable" | "new" | "loaded" | "migrated" | "recovered";
  write: "not-requested" | "written" | "failed" | "capacity-refused";
}

export interface TemporaryReportRequest {
  readonly repositoryRoot: string;
  readonly maxAgeMs: number;
  readonly diagnostics?: boolean;
  readonly reportKind?: "scan-report" | "fix-plan";
  readonly json?: string;
}

export interface TemporaryReportResult {
  readonly diagnostics?: Readonly<ReportMaintenanceDiagnostics>;
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
  diagnostics?: ReportMaintenanceDiagnostics,
): TemporaryReportResult {
  return Object.freeze({
    ...(reportPath === undefined ? {} : { reportPath }),
    warnings: Object.freeze([...warnings]),
    ...(diagnostics === undefined
      ? {}
      : { diagnostics: Object.freeze({ ...diagnostics }) }),
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
