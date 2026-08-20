import { compareFindings } from "../core/summarize.js";
import type { Finding } from "../core/types.js";
import { renderJson } from "../renderers/json.js";
import type { ScanReport } from "../scan/report.js";
import type {
  ReportingSurface as OutputFormat,
  RequestedOutputFormat,
} from "../scan/reporting-options.js";
import { omitReportSourceExcerpts } from "../scan/source-excerpts.js";
import type {
  ReportMaintenanceWarning,
  TemporaryReportStore,
} from "./temporary-reports.js";

export interface TerminalPresentation {
  readonly findings: readonly Finding[];
  readonly totalFindingCount: number;
  readonly abbreviated: boolean;
  readonly reportPath?: string;
  readonly expiresAfterRuns?: number;
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
    warnings.map((warning) => Object.freeze({ ...warning })),
  );
}

function presentation(
  findings: readonly Finding[],
  totalFindingCount: number,
  warnings: readonly ReportMaintenanceWarning[],
  reportPath?: string,
  expiresAfterRuns?: number,
): TerminalPresentation {
  return Object.freeze({
    findings: Object.freeze([...findings]),
    totalFindingCount,
    abbreviated: reportPath !== undefined,
    ...(reportPath === undefined ? {} : { reportPath }),
    ...(expiresAfterRuns === undefined ? {} : { expiresAfterRuns }),
    warnings: freezeWarnings(warnings),
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

export async function prepareTerminalPresentation(
  report: ScanReport,
  options: PreparePresentationOptions,
): Promise<TerminalPresentation> {
  const policy = report.presentationPolicy;
  const orderedFindings = Object.freeze(
    [...report.summary.findings].sort(compareFindings),
  );
  const limit = policy.terminalFindingLimit;
  const shouldPersist =
    limit !== "all" &&
    orderedFindings.length > limit &&
    supportsAbbreviation(options.requestedFormat, options.selectedFormat);
  const maintenanceRequest = {
    repositoryRoot: report.repositoryRoot,
    retentionRuns: policy.temporaryReportRetention,
  };

  if (!shouldPersist) {
    const maintained = await options.store.maintain(maintenanceRequest);
    return presentation(
      orderedFindings,
      orderedFindings.length,
      maintained.warnings,
    );
  }

  let json: string;
  try {
    json = renderJson(
      policy.persistSourceExcerpts ? report : omitReportSourceExcerpts(report),
    );
  } catch (error) {
    await options.store.maintain(maintenanceRequest).catch(() => undefined);
    throw error;
  }

  const maintained = await options.store.maintain({
    ...maintenanceRequest,
    json,
  });
  if (maintained.reportPath === undefined) {
    return presentation(
      orderedFindings,
      orderedFindings.length,
      maintained.warnings,
    );
  }

  return presentation(
    orderedFindings.slice(0, limit),
    orderedFindings.length,
    maintained.warnings,
    maintained.reportPath,
    policy.temporaryReportRetention,
  );
}
