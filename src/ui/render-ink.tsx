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

export async function runInkScan(
  scanOptions: RunScanOptions,
  viewOptions: InkSessionOptions
): Promise<ScanReport> {
  const events: ScanEvent[] = [];
  const started = performance.now();
  const app = render(
    <ScanApp
      events={events}
      elapsedMs={0}
      width={viewOptions.width}
      color={viewOptions.color}
      animations={viewOptions.animations}
    />,
    {
      exitOnCtrlC: false,
      patchConsole: false,
      maxFps: viewOptions.animations ? 30 : 1
    }
  );

  const rerender = (report?: ScanReport): void => {
    app.rerender(
      <ScanApp
        events={[...events]}
        elapsedMs={Math.max(0, performance.now() - started)}
        width={viewOptions.width}
        color={viewOptions.color}
        animations={viewOptions.animations}
        {...(report === undefined ? {} : { report })}
      />
    );
  };

  try {
    const report = await runScan({
      ...scanOptions,
      onEvent(event) {
        events.push(event);
        scanOptions.onEvent?.(event);
        rerender();
      }
    });
    rerender(report);
    await app.waitUntilRenderFlush();
    return report;
  } finally {
    app.unmount();
    await app.waitUntilExit();
  }
}
