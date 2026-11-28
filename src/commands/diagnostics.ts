import { localScanDiagnostics } from "../diagnostics/local-scan-diagnostics.js";
import {
  sanitizeAnalyzerDiagnostic,
  type AnalyzerDiagnostic,
} from "../checks/diagnostics.js";
import { managedCheckMetadata } from "../checks/metadata.js";

const DIAGNOSTIC_STAGES = [
  "repository",
  "analysis",
  "report",
  "apply",
] as const;

const REPORTED_CHECK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "incomplete",
  "skipped",
]);
export type DiagnosticTimings = Partial<
  Record<(typeof DIAGNOSTIC_STAGES)[number], number>
>;

export async function timeCommandStage<T>(
  timings: DiagnosticTimings,
  stage: (typeof DIAGNOSTIC_STAGES)[number],
  operation: () => Promise<T>,
): Promise<T> {
  const started = performance.now();
  try {
    return await operation();
  } finally {
    timings[stage] = Math.max(0, performance.now() - started);
  }
}

function safeDuration(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export interface DiagnosticEntry {
  readonly diagnostic?: AnalyzerDiagnostic;
  readonly durationMs?: number;
  readonly checkId?: string;
  readonly status?: string;
}

/** Optional diagnostics are an observer: malformed metadata or stderr cannot affect work. */
export function writeCommandDiagnostics(
  io: { writeStderr(value: string): void },
  options: {
    readonly command: "scan" | "fix";
    readonly scanDiagnostics?: unknown;
    readonly durationMs: number;
    readonly stages: DiagnosticTimings;
    readonly entries: readonly DiagnosticEntry[];
    readonly cancelled: boolean;
    readonly cleanupFailed: boolean;
    readonly renderingFailed?: boolean;
    readonly reportMaintenance?: unknown;
  },
): void {
  try {
    const analyzers = options.entries.flatMap((entry) => {
      if (entry.diagnostic === undefined) return [];
      try {
        return [
          {
            ...sanitizeAnalyzerDiagnostic(entry.diagnostic),
            ...(safeDuration(entry.durationMs)
              ? { durationMs: entry.durationMs }
              : {}),
          },
        ];
      } catch {
        return [];
      }
    });
    const checks = options.entries.flatMap((entry) =>
      entry.checkId !== undefined &&
      managedCheckMetadata(entry.checkId) !== undefined &&
      entry.status !== undefined &&
      REPORTED_CHECK_STATUSES.has(entry.status) &&
      safeDuration(entry.durationMs)
        ? [
            {
              checkId: entry.checkId,
              status: entry.status,
              durationMs: entry.durationMs,
            },
          ]
        : [],
    );
    const stages = Object.fromEntries(
      DIAGNOSTIC_STAGES.flatMap((stage) =>
        safeDuration(options.stages[stage])
          ? [[stage, options.stages[stage]]]
          : [],
      ),
    );
    const scan = localScanDiagnostics(options.scanDiagnostics);
    const reportMaintenance = safeReportMaintenance(options.reportMaintenance);
    io.writeStderr(
      `ZEDBEE DIAGNOSTICS\n${JSON.stringify({
        command: options.command,
        ...(scan === undefined ? {} : { scan }),
        runtime: {
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
        },
        ...(safeDuration(options.durationMs)
          ? { durationMs: options.durationMs }
          : {}),
        cancelled: options.cancelled,
        cleanupFailed: options.cleanupFailed,
        ...(options.renderingFailed === undefined
          ? {}
          : { renderingFailed: options.renderingFailed }),
        ...(reportMaintenance === undefined ? {} : { reportMaintenance }),
        analyzers,
        checks,
        stages,
      })}\n`,
    );
  } catch {
    /* Diagnostics must not replace the canonical command outcome. */
  }
}

/** Copy only bounded local maintenance facts; reject hostile or unknown metadata. */
function safeReportMaintenance(value: unknown): object | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (
    v.schemaVersion !== 1 ||
    v.protocolVersion !== 2 ||
    !Number.isSafeInteger(v.effectiveMaxAgeMs) ||
    (v.effectiveMaxAgeMs as number) < 0 ||
    ![v.removedExpired, v.alreadyMissing].every(
      (n) =>
        Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 10000,
    ) ||
    !["unavailable", "new", "loaded", "migrated", "recovered"].includes(
      v.state as string,
    ) ||
    !["not-requested", "written", "failed", "capacity-refused"].includes(
      v.write as string,
    )
  )
    return undefined;
  return {
    schemaVersion: 1,
    protocolVersion: 2,
    effectiveMaxAgeMs: v.effectiveMaxAgeMs,
    removedExpired: v.removedExpired,
    alreadyMissing: v.alreadyMissing,
    state: v.state,
    write: v.write,
  };
}

export const SNAPSHOT_CLEANUP_WARNING =
  "SNAPSHOT CLEANUP FAILED\nZedbee could not remove its temporary snapshot.\n";
