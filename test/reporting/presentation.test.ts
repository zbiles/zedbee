import { describe, expect, it, vi } from "vitest";
import { compareFindings } from "../../src/core/summarize.js";
import type { Finding } from "../../src/core/types.js";
import {
  prepareTerminalPresentation,
  type PreparePresentationOptions,
} from "../../src/reporting/presentation.js";
import type {
  TemporaryReportRequest,
  TemporaryReportResult,
  TemporaryReportStore,
} from "../../src/reporting/temporary-reports.js";
import { renderJson } from "../../src/renderers/json.js";
import type { ScanReport } from "../../src/scan/report.js";
import { createFinding, createReport } from "../helpers/scan-report.js";

function findings(count: number, withSource = false): Finding[] {
  return Array.from({ length: count }, (_, index) =>
    createFinding({
      id: `finding-${String(count - index).padStart(2, "0")}`,
      location: {
        file: index % 2 === 0 ? "src/z.ts" : "src/a.ts",
        startLine: count - index,
      },
      ...(withSource
        ? {
            sourceExcerpt: {
              line: count - index,
              text: `const value${index} = ${index};`,
              redacted: false,
              truncated: false,
            },
          }
        : {}),
    }),
  );
}

function reportWithFindings(
  count: number,
  overrides: Partial<ScanReport> = {},
): ScanReport {
  const reportFindings = findings(count, true);
  return createReport({
    outcome: count === 0 ? "pass" : "blocked",
    exitCode: count === 0 ? 0 : 1,
    summary: {
      passed: 0,
      warnings: 0,
      failed: count,
      incomplete: 0,
      findings: reportFindings,
    },
    checks: [
      {
        checkId: "formatting",
        status: "completed",
        durationMs: 4,
        findings: reportFindings,
      },
    ],
    ...overrides,
  });
}

function recordingStore(result: TemporaryReportResult = { warnings: [] }): {
  readonly store: TemporaryReportStore;
  readonly maintain: ReturnType<typeof vi.fn>;
} {
  const maintain = vi.fn(
    async (_request: TemporaryReportRequest): Promise<TemporaryReportResult> =>
      result,
  );
  return { store: { maintain }, maintain };
}

function options(
  store: TemporaryReportStore,
  requestedFormat: PreparePresentationOptions["requestedFormat"],
  selectedFormat: PreparePresentationOptions["selectedFormat"],
): PreparePresentationOptions {
  return { store, requestedFormat, selectedFormat };
}

describe("prepareTerminalPresentation", () => {
  it.each([
    ["auto", "ink", 26, 25, true],
    ["auto", "text", 26, 25, true],
    ["ink", "ink", 26, 25, true],
    ["auto", "ink", 25, 25, false],
    ["auto", "text", 25, 25, false],
    ["ink", "ink", 25, 25, false],
    ["text", "text", 26, 26, false],
    ["json", "json", 26, 26, false],
    ["sarif", "sarif", 26, 26, false],
  ] as const)(
    "%s/%s with %i findings selects %i and persistence=%s",
    async (requested, selected, count, expectedCount, shouldPersist) => {
      const { store, maintain } = recordingStore(
        shouldPersist
          ? { reportPath: "/tmp/zedbee/report.json", warnings: [] }
          : { warnings: [] },
      );
      const report = reportWithFindings(count);

      const presentation = await prepareTerminalPresentation(
        report,
        options(store, requested, selected),
      );

      expect(maintain).toHaveBeenCalledTimes(1);
      expect(maintain).toHaveBeenCalledWith({
        repositoryRoot: "/repo",
        maxAgeMs: 86_400_000,
        ...(shouldPersist ? { json: expect.any(String) } : {}),
      });
      expect(presentation.findings).toHaveLength(expectedCount);
      expect(presentation.totalFindingCount).toBe(count);
      expect(presentation.abbreviated).toBe(shouldPersist);
      expect(presentation.reportPath).toBe(
        shouldPersist ? "/tmp/zedbee/report.json" : undefined,
      );
      expect(presentation.maximumAge).toBe(shouldPersist ? "24h" : undefined);
      expect(presentation.completeOutputFallback).toBeUndefined();
      expect(presentation.findings).toEqual(
        [...report.summary.findings]
          .sort(compareFindings)
          .slice(0, expectedCount),
      );
    },
  );

  it("keeps every finding and only maintains lifecycle state when the limit is all", async () => {
    const { store, maintain } = recordingStore();
    const report = reportWithFindings(26, {
      presentationPolicy: {
        terminalFindingLimit: "all",
        temporaryReportMaxAge: "7d",
        persistSourceExcerpts: false,
      },
    });

    const presentation = await prepareTerminalPresentation(
      report,
      options(store, "auto", "ink"),
    );

    expect(presentation.findings).toHaveLength(26);
    expect(presentation.abbreviated).toBe(false);
    expect(maintain).toHaveBeenCalledOnce();
    expect(maintain).toHaveBeenCalledWith({
      repositoryRoot: "/repo",
      maxAgeMs: 604_800_000,
    });
  });

  it("stores complete canonical JSON before selecting the ordered preview", async () => {
    const { store, maintain } = recordingStore({
      reportPath: "/tmp/zedbee/complete.json",
      warnings: [],
    });
    const report = reportWithFindings(26, {
      presentationPolicy: {
        terminalFindingLimit: 3,
        temporaryReportMaxAge: "24h",
        persistSourceExcerpts: true,
      },
    });

    const presentation = await prepareTerminalPresentation(
      report,
      options(store, "auto", "text"),
    );

    const request = maintain.mock.calls[0]?.[0] as TemporaryReportRequest;
    expect(request.json).toBe(renderJson(report));
    expect(JSON.parse(request.json ?? "").checks[0].findings).toHaveLength(26);
    expect(presentation.findings).toEqual(
      [...report.summary.findings].sort(compareFindings).slice(0, 3),
    );
  });

  it("omits ordinary source from stored JSON under the default persistence policy", async () => {
    const { store, maintain } = recordingStore({
      reportPath: "/tmp/zedbee/complete.json",
      warnings: [],
    });
    const report = reportWithFindings(26);

    await prepareTerminalPresentation(report, options(store, "auto", "ink"));

    const request = maintain.mock.calls[0]?.[0] as TemporaryReportRequest;
    expect(request.json).not.toContain("const value");
    expect(request.json).not.toContain('"text"');
  });

  it.each(["always", "--include-source"])(
    "preserves ordinary source when resolved policy represents %s",
    async () => {
      const { store, maintain } = recordingStore({
        reportPath: "/tmp/zedbee/complete.json",
        warnings: [],
      });
      const report = reportWithFindings(26, {
        presentationPolicy: {
          terminalFindingLimit: 25,
          temporaryReportMaxAge: "24h",
          persistSourceExcerpts: true,
        },
      });

      await prepareTerminalPresentation(report, options(store, "auto", "ink"));

      const request = maintain.mock.calls[0]?.[0] as TemporaryReportRequest;
      expect(request.json).toContain("const value");
    },
  );

  it("strips ordinary source when resolved policy represents --no-source", async () => {
    const { store, maintain } = recordingStore({
      reportPath: "/tmp/zedbee/complete.json",
      warnings: [],
    });
    const report = reportWithFindings(26, {
      presentationPolicy: {
        terminalFindingLimit: 25,
        temporaryReportMaxAge: "24h",
        persistSourceExcerpts: false,
      },
    });

    await prepareTerminalPresentation(report, options(store, "ink", "ink"));

    const request = maintain.mock.calls[0]?.[0] as TemporaryReportRequest;
    expect(request.json).not.toContain("const value");
  });

  it("retains a redacted marker without secret source text", async () => {
    const reportFindings = findings(25, true);
    reportFindings.push(
      createFinding({
        id: "secret-finding",
        check: "secrets",
        location: { file: "src/secret.ts", startLine: 7 },
        sourceExcerpt: {
          line: 7,
          redacted: true,
          truncated: false,
        },
      }),
    );
    const report = reportWithFindings(26, {
      presentationPolicy: {
        terminalFindingLimit: 25,
        temporaryReportMaxAge: "24h",
        persistSourceExcerpts: true,
      },
      summary: {
        passed: 0,
        warnings: 0,
        failed: 26,
        incomplete: 0,
        findings: reportFindings,
      },
      checks: [
        {
          checkId: "secrets",
          status: "completed",
          durationMs: 1,
          findings: reportFindings,
        },
      ],
    });
    const { store, maintain } = recordingStore({
      reportPath: "/tmp/zedbee/complete.json",
      warnings: [],
    });

    await prepareTerminalPresentation(report, options(store, "auto", "ink"));

    const request = maintain.mock.calls[0]?.[0] as TemporaryReportRequest;
    const stored = JSON.parse(request.json ?? "") as {
      checks: { findings: { id: string; sourceExcerpt?: object }[] }[];
    };
    expect(
      stored.checks[0]?.findings.find(
        (finding) => finding.id === "secret-finding",
      )?.sourceExcerpt,
    ).toEqual({ line: 7, redacted: true, truncated: false });
  });

  it("falls back to the complete finding set when report persistence fails", async () => {
    const writeWarning = {
      code: "TEMP_REPORT_WRITE_FAILED" as const,
      message: "The report could not be written.",
    };
    const { store } = recordingStore({ warnings: [writeWarning] });
    const report = reportWithFindings(26);

    const presentation = await prepareTerminalPresentation(
      report,
      options(store, "auto", "ink"),
    );

    expect(presentation.findings).toHaveLength(26);
    expect(presentation.abbreviated).toBe(false);
    expect(presentation.reportPath).toBeUndefined();
    expect(presentation.maximumAge).toBeUndefined();
    expect(presentation.completeOutputFallback).toBe(true);
    expect(presentation.warnings).toEqual([writeWarning]);
  });

  it("keeps a successful preview when cleanup produces a warning", async () => {
    const cleanupWarning = {
      code: "TEMP_REPORT_CLEANUP_FAILED" as const,
      message: "An expired report remains.",
      path: "/tmp/zedbee/expired.json",
    };
    const { store } = recordingStore({
      reportPath: "/tmp/zedbee/complete.json",
      warnings: [cleanupWarning],
    });
    const report = reportWithFindings(26);

    const presentation = await prepareTerminalPresentation(
      report,
      options(store, "auto", "ink"),
    );

    expect(presentation.findings).toHaveLength(25);
    expect(presentation.abbreviated).toBe(true);
    expect(presentation.warnings).toEqual([cleanupWarning]);
    expect(report.exitCode).toBe(1);
  });

  it.each([
    ["report", "/tmp/unsafe\u001b[31m.json", undefined],
    ["warning", "/tmp/valid.json", "/tmp/unsafe\u202e.json"],
  ] as const)(
    "rejects an unsafe %s path before publishing a presentation",
    async (_kind, reportPath, warningPath) => {
      const { store } = recordingStore({
        reportPath,
        warnings:
          warningPath === undefined
            ? []
            : [
                {
                  code: "TEMP_REPORT_CLEANUP_FAILED",
                  message: "Cleanup failed.",
                  path: warningPath,
                },
              ],
      });

      await expect(
        prepareTerminalPresentation(
          reportWithFindings(26),
          options(store, "auto", "text"),
        ),
      ).rejects.toThrow(/safe temporary report path display text/u);
    },
  );

  it("returns immutable presentation containers", async () => {
    const { store } = recordingStore({
      reportPath: "/tmp/zedbee/complete.json",
      warnings: [
        {
          code: "TEMP_REPORT_CLEANUP_FAILED",
          message: "An expired report remains.",
        },
      ],
    });

    const presentation = await prepareTerminalPresentation(
      reportWithFindings(26),
      options(store, "auto", "ink"),
    );

    expect(Object.isFrozen(presentation)).toBe(true);
    expect(Object.isFrozen(presentation.findings)).toBe(true);
    expect(Object.isFrozen(presentation.warnings)).toBe(true);
    expect(Object.isFrozen(presentation.warnings[0])).toBe(true);
  });

  it("propagates JSON sanitization errors while still maintaining lifecycle state", async () => {
    const { store, maintain } = recordingStore();
    const invalid = createFinding({ message: "unsafe\u001b[31m" });
    const report = reportWithFindings(26, {
      summary: {
        passed: 0,
        warnings: 0,
        failed: 26,
        incomplete: 0,
        findings: [invalid, ...findings(25)],
      },
      checks: [
        {
          checkId: "formatting",
          status: "completed",
          durationMs: 4,
          findings: [invalid, ...findings(25)],
        },
      ],
    });

    await expect(
      prepareTerminalPresentation(report, options(store, "auto", "ink")),
    ).rejects.toThrow(/display text/i);
    expect(maintain).toHaveBeenCalledOnce();
    expect(maintain).toHaveBeenCalledWith({
      repositoryRoot: "/repo",
      maxAgeMs: 86_400_000,
    });
  });
});
