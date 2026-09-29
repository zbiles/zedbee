import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { sendTelemetry } from "../../src/telemetry/transport.js";
import { telemetryEventSchema } from "../../src/telemetry/schema.js";
const event = telemetryEventSchema.parse({
  schema_version: 1,
  event: "scan_started",
  event_id: randomUUID(),
  run_id: randomUUID(),
  timestamp: new Date().toISOString(),
  version: "0.1.0",
  os: "linux",
  arch: "x64",
  node_major: 24,
  command: "scan",
  environment: "ci_not_detected",
  invocation_source: "unspecified",
  installation_id: randomUUID(),
  scan_mode: "staged",
});
describe("bounded telemetry transport", () => {
  it.each([
    [204, true],
    [400, true],
    [413, true],
    [422, true],
    [429, false],
    [503, false],
    [302, false],
  ])("acknowledges status %s only when terminal", async (status, want) => {
    let options: RequestInit | undefined;
    let url: unknown;
    const result = await sendTelemetry(
      [event],
      new AbortController().signal,
      async (input, init) => {
        url = input;
        options = init;
        return new Response(null, { status });
      },
    );
    expect(result).toBe(want);
    expect(url).toBe("https://telemetry.zedbee.dev/v1/events");
    expect(options?.redirect).toBe("error");
    expect(JSON.parse(options!.body as string).events[0].event_id).toBe(
      event.event_id,
    );
  });
  it("skips invalid payloads before transport and treats network errors as nonfatal", async () => {
    let calls = 0;
    const sender: typeof fetch = async () => {
      calls++;
      throw Error("offline");
    };
    expect(
      await sendTelemetry(
        [{ ...event, path: "private" } as typeof event],
        new AbortController().signal,
        sender,
      ),
    ).toBe(false);
    expect(calls).toBe(0);
    expect(
      await sendTelemetry([event], new AbortController().signal, sender),
    ).toBe(false);
    expect(calls).toBe(1);
  });
});
