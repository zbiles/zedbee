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
import { renderStaticInk } from "./render-static.js";
import { ScanApp } from "./scan-app.js";
import { ScanResultDashboard } from "./scan-result-dashboard.js";

export interface InkSessionOptions {
  requestedFormat: "auto" | "ink";
  color: boolean;
  animations: boolean;
  width: number;
}

export interface InkScanDependencies {
  readonly preparePresentation?: typeof prepareTerminalPresentation;
  readonly store?: TemporaryReportStore;
  readonly interactive?: boolean;
}

export const INK_ANIMATION_FRAME_MS = 80;
export const INK_MINIMUM_DISPLAY_MS = 400;
export const INK_EVENT_MAX_FPS = 30;
const CURSOR_HOME = "\u001b[H";

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
  let homeTemporaryScreen =
    viewOptions.requestedFormat === "auto" &&
    process.stdout.isTTY === true &&
    dependencies.interactive !== false;
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
      alternateScreen: viewOptions.requestedFormat === "auto",
      onRender() {
        if (!homeTemporaryScreen) return;
        homeTemporaryScreen = false;
        process.stdout.write(CURSOR_HOME);
      },
      ...(dependencies.interactive === undefined
        ? {}
        : { interactive: dependencies.interactive }),
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
  let liveMounted = true;
  const unmountLive = async (): Promise<void> => {
    if (!liveMounted) return;
    liveMounted = false;
    app.unmount();
    await app.waitUntilExit();
  };

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
      requestedFormat: viewOptions.requestedFormat,
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
    if (viewOptions.requestedFormat === "auto") {
      await unmountLive();
      await renderStaticInk(
        <ScanResultDashboard
          report={report}
          presentation={presentation}
          width={viewOptions.width}
          color={viewOptions.color}
        />,
        { width: viewOptions.width },
      );
      return report;
    }
    rerender(report, presentation);
    await app.waitUntilRenderFlush();
    return report;
  } finally {
    if (ticker !== undefined) clearInterval(ticker);
    await unmountLive();
  }
}
