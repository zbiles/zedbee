import { telemetryBatchSchema, type TelemetryEvent } from "./schema.js";
import { TELEMETRY_REQUEST_BYTES } from "./batch.js";
export const TELEMETRY_ENDPOINT = "https://telemetry.zedbee.dev/v1/events";
export type TelemetrySend = (
  events: readonly TelemetryEvent[],
  signal: AbortSignal,
) => Promise<boolean>;
/** True means terminal acknowledgement, including permanently rejected wire versions. */
export async function sendTelemetry(
  events: readonly TelemetryEvent[],
  signal: AbortSignal,
  fetcher: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const batch = telemetryBatchSchema.parse({ events });
    const body = JSON.stringify(batch);
    if (Buffer.byteLength(body) > TELEMETRY_REQUEST_BYTES) return false;
    const response = await fetcher(TELEMETRY_ENDPOINT, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      headers: { "content-type": "application/json" },
      body,
    });
    // The collector's acknowledgement has no body; never buffer arbitrary remote content.
    await response.body?.cancel();
    return response.status === 204 || [400, 413, 422].includes(response.status);
  } catch {
    return false;
  }
}
