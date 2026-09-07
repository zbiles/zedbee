import {
  sanitizeAnalyzerDiagnostic,
  type AnalyzerDiagnostic,
} from "../checks/diagnostics.js";

export interface DiagnosticEntry {
  readonly diagnostic?: AnalyzerDiagnostic;
  readonly durationMs?: number;
}

/** Optional diagnostics are an observer: malformed metadata or stderr cannot affect work. */
export function writeCommandDiagnostics(
  io: { writeStderr(value: string): void },
  options: {
    readonly command: "scan" | "fix";
    readonly durationMs: number;
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
            ...(Number.isFinite(entry.durationMs) && entry.durationMs! >= 0
              ? { durationMs: entry.durationMs }
              : {}),
          },
        ];
      } catch {
        return [];
      }
    });
    io.writeStderr(
      `ZEDBEE DIAGNOSTICS\n${JSON.stringify({
        command: options.command,
        runtime: {
          node: process.versions.node,
          platform: process.platform,
          arch: process.arch,
        },
        ...(Number.isFinite(options.durationMs) && options.durationMs >= 0
          ? { durationMs: options.durationMs }
          : {}),
        cancelled: options.cancelled,
        cleanupFailed: options.cleanupFailed,
        ...(options.renderingFailed === undefined
          ? {}
          : { renderingFailed: options.renderingFailed }),
        analyzers,
      })}\n`,
    );
  } catch {
    /* Diagnostics must not replace the canonical command outcome. */
  }
}

export const SNAPSHOT_CLEANUP_WARNING =
  "SNAPSHOT CLEANUP FAILED\nZedbee could not remove its temporary snapshot.\n";
