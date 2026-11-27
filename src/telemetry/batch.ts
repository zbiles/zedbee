import type { TelemetryEvent } from "./schema.js";
export const TELEMETRY_REQUEST_BYTES = 60 * 1024;
const EMPTY_BATCH_BYTES = Buffer.byteLength(JSON.stringify({ events: [] }));
export function telemetryBatches(
  events: readonly TelemetryEvent[],
): TelemetryEvent[][] {
  const batches: TelemetryEvent[][] = [];
  let current: TelemetryEvent[] = [];
  let currentBytes = EMPTY_BATCH_BYTES;
  for (const event of events) {
    const eventBytes = Buffer.byteLength(JSON.stringify(event));
    if (EMPTY_BATCH_BYTES + eventBytes > TELEMETRY_REQUEST_BYTES)
      throw Error("Telemetry event exceeds request budget");
    const separatorBytes = current.length > 0 ? 1 : 0;
    if (
      current.length >= 20 ||
      currentBytes + separatorBytes + eventBytes > TELEMETRY_REQUEST_BYTES
    ) {
      batches.push(current);
      current = [];
      currentBytes = EMPTY_BATCH_BYTES;
    }
    currentBytes += (current.length > 0 ? 1 : 0) + eventBytes;
    current.push(event);
  }
  if (current.length) batches.push(current);
  return batches;
}
