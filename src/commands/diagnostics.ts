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
    readonly durationMs: number;
    readonly stages: DiagnosticTimings;
    readonly entries: readonly DiagnosticEntry[];
    readonly cancelled: boolean;
    readonly cleanupFailed: boolean;
    readonly renderingFailed?: boolean;
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
      ["completed", "incomplete", "skipped"].includes(entry.status) &&
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
    io.writeStderr(
      `ZEDBEE DIAGNOSTICS\n${JSON.stringify({
        command: options.command,
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
        analyzers,
        checks,
        stages,
      })}\n`,
    );
  } catch {
    /* Diagnostics must not replace the canonical command outcome. */
  }
}

export const SNAPSHOT_CLEANUP_WARNING =
  "SNAPSHOT CLEANUP FAILED\nZedbee could not remove its temporary snapshot.\n";
