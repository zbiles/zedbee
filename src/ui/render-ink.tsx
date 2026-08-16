import { render } from "ink";
import type { ScanEvent } from "../checks/events.js";
import { runScan, type RunScanOptions } from "../scan/run-scan.js";
import type { ScanReport } from "../scan/report.js";
import { ScanApp } from "./scan-app.js";

export interface InkSessionOptions {
  color: boolean;
  animations: boolean;
  width: number;
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

  const rerender = (report?: ScanReport): void => {
    app.rerender(
      <ScanApp
        events={[...events]}
        startedAt={started}
        elapsedMs={Math.max(0, performance.now() - started)}
        width={viewOptions.width}
        color={viewOptions.color}
        animations={viewOptions.animations}
        {...(report === undefined ? {} : { report })}
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
    if (viewOptions.animations) {
      const remaining =
        INK_MINIMUM_DISPLAY_MS - Math.max(0, performance.now() - started);
      if (remaining > 0) await wait(remaining);
    }
    if (ticker !== undefined) clearInterval(ticker);
    rerender(report);
    await app.waitUntilRenderFlush();
    return report;
  } finally {
    if (ticker !== undefined) clearInterval(ticker);
    app.unmount();
    await app.waitUntilExit();
  }
}
