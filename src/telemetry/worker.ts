import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { telemetryContext, telemetryDisabled } from "./policy.js";
import { TelemetryStore, telemetryDirectory } from "./state.js";
import { sendTelemetry, type TelemetrySend } from "./transport.js";
export async function drainTelemetry(
  store: TelemetryStore,
  signal: AbortSignal,
  send: TelemetrySend = sendTelemetry,
): Promise<void> {
  let release: (() => void) | undefined;
  try {
    if (
      telemetryDisabled(process.env) ||
      telemetryContext(process.env).environment === "ci"
    )
      return;
    release = store.lock("sender.lock");
    for (let attempt = 0; attempt < 5 && !signal.aborted; attempt++) {
      if (telemetryDisabled(process.env)) return;
      const events = store.pending().slice(0, 20);
      if (events.length === 0) return;
      if (!(await send(events, signal))) return;
      store.acknowledge(events.map((event) => event.event_id));
    }
  } catch {
    /* Busy, unreadable, disabled, or offline: leave bounded events for later. */
  } finally {
    release?.();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const controller = new AbortController();
  const deadline = setTimeout(() => {
    controller.abort();
    process.exit(0);
  }, 5000);
  try {
    await drainTelemetry(
      new TelemetryStore(telemetryDirectory(process.env)),
      controller.signal,
    );
  } finally {
    clearTimeout(deadline);
  }
}
