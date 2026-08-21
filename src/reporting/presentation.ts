import { compareFindings } from "../core/summarize.js";
import type { Finding } from "../core/types.js";
import { renderJson } from "../renderers/json.js";
import type { ScanReport } from "../scan/report.js";
import type {
  ReportingSurface as OutputFormat,
  RequestedOutputFormat,
} from "../scan/reporting-options.js";
import { omitReportSourceExcerpts } from "../scan/source-excerpts.js";
import { parseTemporaryReportMaxAge } from "./report-age.js";
import { validateTemporaryReportPath } from "./report-path.js";
import type {
  ReportMaintenanceWarning,
  TemporaryReportStore,
} from "./temporary-reports.js";

export type TerminalReportStatus =
  "available" | "unavailable" | "not-requested";

export interface TerminalPresentation {
  readonly automatic: boolean;
  readonly reportStatus: TerminalReportStatus;
  readonly findings: readonly Finding[];
  readonly totalFindingCount: number;
  readonly abbreviated: boolean;
  readonly reportPath?: string;
  readonly maximumAge?: string;
  readonly completeOutputFallback?: boolean;
  readonly warnings: readonly ReportMaintenanceWarning[];
}

export interface PreparePresentationOptions {
  readonly requestedFormat: RequestedOutputFormat;
  readonly selectedFormat: OutputFormat;
  readonly store: TemporaryReportStore;
}

function freezeWarnings(
  warnings: readonly ReportMaintenanceWarning[],
): readonly ReportMaintenanceWarning[] {
  return Object.freeze(
    warnings.map((warning) =>
      Object.freeze({
        ...warning,
        ...(warning.path === undefined
          ? {}
          : { path: validateTemporaryReportPath(warning.path) }),
      }),
    ),
  );
}

function presentation(input: {
  readonly automatic: boolean;
  readonly reportStatus: TerminalReportStatus;
  readonly findings: readonly Finding[];
  readonly totalFindingCount: number;
  readonly abbreviated: boolean;
  readonly warnings: readonly ReportMaintenanceWarning[];
  readonly reportPath?: string;
  readonly maximumAge?: string;
  readonly completeOutputFallback?: boolean;
}): TerminalPresentation {
  return Object.freeze({
    automatic: input.automatic,
    reportStatus: input.reportStatus,
    findings: Object.freeze([...input.findings]),
    totalFindingCount: input.totalFindingCount,
    abbreviated: input.abbreviated,
    ...(input.reportPath === undefined
      ? {}
      : { reportPath: validateTemporaryReportPath(input.reportPath) }),
    ...(input.maximumAge === undefined ? {} : { maximumAge: input.maximumAge }),
    ...(input.completeOutputFallback ? { completeOutputFallback: true } : {}),
    warnings: freezeWarnings(input.warnings),
  });
}

function supportsAbbreviation(
  requestedFormat: RequestedOutputFormat,
  selectedFormat: OutputFormat,
): boolean {
  if (requestedFormat === "auto") {
    return selectedFormat === "ink" || selectedFormat === "text";
  }
  return requestedFormat === "ink" && selectedFormat === "ink";
}

function prioritizePreview(
  findings: readonly Finding[],
  limit: number,
): readonly Finding[] {
  const blocking = findings.filter(({ severity }) => severity === "error");
  const warnings = findings.filter(({ severity }) => severity !== "error");
  const selectedBlocking = blocking.slice(0, limit);
  return Object.freeze([
    ...selectedBlocking,
    ...warnings.slice(0, Math.max(0, limit - selectedBlocking.length)),
  ]);
}

function writeFailureWarning(): ReportMaintenanceWarning {
  return Object.freeze({
    code: "TEMP_REPORT_WRITE_FAILED",
    message: "The temporary report could not be written.",
  });
}

export async function prepareTerminalPresentation(
  report: ScanReport,
  options: PreparePresentationOptions,
): Promise<TerminalPresentation> {
  const policy = report.presentationPolicy;
  const orderedFindings = Object.freeze(
    [...report.summary.findings].sort(compareFindings),
  );
  const limit = policy.terminalFindingLimit;
  const automatic = options.requestedFormat === "auto";
  const canPreview = supportsAbbreviation(
    options.requestedFormat,
    options.selectedFormat,
  );
  const abbreviated =
    limit !== "all" && orderedFindings.length > limit && canPreview;
  const shouldPersist =
    automatic || (options.requestedFormat === "ink" && abbreviated);
  const maintenanceRequest = {
    repositoryRoot: report.repositoryRoot,
    maxAgeMs: parseTemporaryReportMaxAge(policy.temporaryReportMaxAge),
  };

  if (!shouldPersist) {
    const maintained = await options.store.maintain(maintenanceRequest);
    return presentation({
      automatic,
      reportStatus: "not-requested",
      findings: orderedFindings,
      totalFindingCount: orderedFindings.length,
      abbreviated: false,
      warnings: maintained.warnings,
    });
  }

  let json: string;
  try {
    json = renderJson(
      policy.persistSourceExcerpts ? report : omitReportSourceExcerpts(report),
    );
  } catch {
    const maintained = await options.store
      .maintain(maintenanceRequest)
      .catch(() => ({ warnings: [] }));
    return presentation({
      automatic,
      reportStatus: "unavailable",
      findings: orderedFindings,
      totalFindingCount: orderedFindings.length,
      abbreviated: false,
      warnings: [...maintained.warnings, writeFailureWarning()],
      completeOutputFallback: true,
    });
  }

  const maintained = await options.store
    .maintain({ ...maintenanceRequest, json })
    .catch(() => undefined);
  if (maintained?.reportPath === undefined) {
    return presentation({
      automatic,
      reportStatus: "unavailable",
      findings: orderedFindings,
      totalFindingCount: orderedFindings.length,
      abbreviated: false,
      warnings:
        maintained === undefined
          ? [writeFailureWarning()]
          : maintained.warnings,
      completeOutputFallback: true,
    });
  }

  return presentation({
    automatic,
    reportStatus: "available",
    findings: abbreviated
      ? prioritizePreview(orderedFindings, limit)
      : orderedFindings,
    totalFindingCount: orderedFindings.length,
    abbreviated,
    warnings: maintained.warnings,
    reportPath: maintained.reportPath,
    maximumAge: policy.temporaryReportMaxAge,
  });
}
