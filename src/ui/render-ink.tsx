import { render } from "ink";
import type { ScanEvent } from "../checks/events.js";
import {
  prepareTerminalPresentation,
  type PreparePresentationOptions,
  type TerminalPresentation,
} from "../reporting/presentation.js";
import {
  createTemporaryReportStore,
  type TemporaryReportStore,
} from "../reporting/temporary-reports.js";
import { runScan, type RunScanOptions } from "../scan/run-scan.js";
import type { ScanReport } from "../scan/report.js";
import { ScanApp } from "./scan-app.js";

export interface InkSessionOptions {
  color: boolean;
  animations: boolean;
  width: number;
}

export interface InkScanDependencies {
  readonly preparePresentation?: typeof prepareTerminalPresentation;
  readonly store?: TemporaryReportStore;
}

export const INK_ANIMATION_FRAME_MS = 80;
export const INK_MINIMUM_DISPLAY_MS = 400;
export const INK_EVENT_MAX_FPS = 30;

export function inkMaxFps(_animations: boolean): number {
  return INK_EVENT_MAX_FPS;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function runInkScan(
  scanOptions: RunScanOptions,
  viewOptions: InkSessionOptions,
  dependencies: InkScanDependencies = {},
): Promise<ScanReport> {
  const events: ScanEvent[] = [];
  const started = performance.now();
  const app = render(
    <ScanApp
      events={events}
      startedAt={started}
      elapsedMs={0}
      width={viewOptions.width}
      color={viewOptions.color}
      animations={viewOptions.animations}
    />,
    {
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: inkMaxFps(viewOptions.animations),
    },
  );

  const rerender = (
    report?: ScanReport,
    presentation?: TerminalPresentation,
  ): void => {
    app.rerender(
      <ScanApp
        events={[...events]}
        startedAt={started}
        elapsedMs={Math.max(0, performance.now() - started)}
        width={viewOptions.width}
        color={viewOptions.color}
        animations={viewOptions.animations}
        {...(report === undefined ? {} : { report })}
        {...(presentation === undefined ? {} : { presentation })}
      />,
    );
  };

  const ticker = viewOptions.animations
    ? setInterval(rerender, INK_ANIMATION_FRAME_MS)
    : undefined;

  try {
    const report = await runScan({
      ...scanOptions,
      onEvent(event) {
        events.push(event);
        scanOptions.onEvent?.(event);
        rerender();
      },
    });
    const presentationOptions: PreparePresentationOptions = {
      requestedFormat: "ink",
      selectedFormat: "ink",
      store: dependencies.store ?? createTemporaryReportStore(),
    };
    const presentation = await (
      dependencies.preparePresentation ?? prepareTerminalPresentation
    )(report, presentationOptions);
    if (viewOptions.animations) {
      const remaining =
        INK_MINIMUM_DISPLAY_MS - Math.max(0, performance.now() - started);
      if (remaining > 0) await wait(remaining);
    }
    if (ticker !== undefined) clearInterval(ticker);
    rerender(report, presentation);
    await app.waitUntilRenderFlush();
    return report;
  } finally {
    if (ticker !== undefined) clearInterval(ticker);
    app.unmount();
    await app.waitUntilExit();
  }
}
