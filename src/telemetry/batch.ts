import type { TelemetryEvent } from "./schema.js";
export const TELEMETRY_REQUEST_BYTES = 60 * 1024;
export function telemetryBatches(
  events: readonly TelemetryEvent[],
): TelemetryEvent[][] {
  const batches: TelemetryEvent[][] = [];
  let current: TelemetryEvent[] = [];
  for (const event of events) {
    if (
      Buffer.byteLength(JSON.stringify({ events: [event] })) >
      TELEMETRY_REQUEST_BYTES
    )
      throw Error("Telemetry event exceeds request budget");
    if (
      current.length >= 20 ||
      Buffer.byteLength(JSON.stringify({ events: [...current, event] })) >
        TELEMETRY_REQUEST_BYTES
    ) {
      batches.push(current);
      current = [];
    }
    current.push(event);
  }
  if (current.length) batches.push(current);
  return batches;
}
