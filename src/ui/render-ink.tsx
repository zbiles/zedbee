import { render } from "ink";
import type { InkRenderOptions, InkSession } from "../commands/scan.js";
import type { TerminalPresentation } from "../reporting/presentation.js";
import type { ScanReport } from "../scan/report.js";
import { createScanProgress, updateScanProgress } from "./live-dashboard.js";
import { renderStaticInk } from "./render-static.js";
import { ScanApp } from "./scan-app.js";
import { ScanResultDashboard } from "./scan-result-dashboard.js";

export interface InkSessionDependencies {
  readonly interactive?: boolean;
  readonly wait?: (milliseconds: number) => Promise<void>;
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

/** Observes events and the final report; analysis and persistence belong to the controller. */
export async function openInkSession(
  viewOptions: InkRenderOptions,
  onError: () => void,
  dependencies: InkSessionDependencies = {},
): Promise<InkSession> {
  const progress = createScanProgress();
  const started = performance.now();
  let failed = false;
  const notifyError = (): void => {
    failed = true;
    try {
      onError();
    } catch {
      /* Error observers are presentation only. */
    }
  };
  let homeTemporaryScreen =
    viewOptions.requestedFormat === "auto" &&
    process.stdout.isTTY === true &&
    dependencies.interactive !== false;
  const app = render(
    <ScanApp
      progress={progress}
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
        try {
          process.stdout.write(CURSOR_HOME);
        } catch {
          notifyError();
        }
      },
      ...(dependencies.interactive === undefined
        ? {}
        : { interactive: dependencies.interactive }),
    },
  );
  // Observe asynchronous Ink failures immediately, without exposing their causes.
  const exited = app.waitUntilExit();
  void exited.catch(notifyError);
  const rerender = (
    report?: ScanReport,
    presentation?: TerminalPresentation,
  ): void => {
    app.rerender(
      <ScanApp
        progress={progress}
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
    ? setInterval(() => {
        if (failed) return;
        try {
          rerender();
        } catch {
          notifyError();
        }
      }, INK_ANIMATION_FRAME_MS)
    : undefined;
  let liveMounted = true;
  const close = async (): Promise<void> => {
    if (ticker !== undefined) clearInterval(ticker);
    if (!liveMounted) return;
    liveMounted = false;
    app.unmount();
    await exited;
  };
  return {
    update(event) {
      if (!liveMounted || failed) return;
      updateScanProgress(progress, event);
      rerender();
    },
    async finish(report, presentation) {
      if (viewOptions.animations) {
        const remaining =
          INK_MINIMUM_DISPLAY_MS - Math.max(0, performance.now() - started);
        if (remaining > 0) await (dependencies.wait ?? wait)(remaining);
      }
      if (ticker !== undefined) clearInterval(ticker);
      if (failed) return;
      if (viewOptions.requestedFormat === "auto") {
        await close();
        await renderStaticInk(
          <ScanResultDashboard
            report={report}
            presentation={presentation}
            width={viewOptions.width}
            color={viewOptions.color}
          />,
          { width: viewOptions.width },
        );
      } else {
        rerender(report, presentation);
        await app.waitUntilRenderFlush();
      }
    },
    close,
  };
}
