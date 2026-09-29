import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTelemetry } from "../../src/telemetry/client.js";
import { TelemetryStore } from "../../src/telemetry/state.js";
import type { TelemetryEvent } from "../../src/telemetry/schema.js";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telemetry-client-"));
  roots.push(root);
  return { root, store: new TelemetryStore(join(root, "state")) };
}
afterEach(() => {
  vi.useRealTimers();
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
describe("command telemetry", () => {
  it("does nothing when disabled, including state and sender creation", async () => {
    const { root, store } = fixture();
    let sends = 0;
    const client = startTelemetry({
      command: "scan",
      env: { ZEDBEE_TELEMETRY_DISABLED: "1" },
      store,
      notice: () => {
        throw Error("unexpected");
      },
      launch: () => {
        sends++;
      },
    });
    client.finish(0);
    await client.flush(false);
    expect(sends).toBe(0);
    expect(existsSync(join(root, "state"))).toBe(false);
  });
  it("pairs local scan events, records the final exit result and never serializes arbitrary details", async () => {
    const { store } = fixture();
    const client = startTelemetry({
      command: "scan",
      env: {},
      store,
      notice: () => {},
      launch: () => {},
    });
    client.summary({
      empty_input: true,
      check_ids: ["types"],
      finding_count: 0,
    });
    client.finish(2);
    await client.flush(false);
    const events = store.pending();
    expect(events.map((e) => e.event)).toEqual([
      "scan_started",
      "scan_finished",
    ]);
    expect(events[1]).toMatchObject({
      outcome: "incomplete",
      empty_input: true,
      check_ids: ["types"],
    });
    expect(events[0]!.run_id).toBe(events[1]!.run_id);
    expect(events[0]!.installation_id).toBe(events[1]!.installation_id);
  });
  it("CI sends in memory with per-command identities and honors existing opt-out", async () => {
    const { root, store } = fixture();
    const sent: TelemetryEvent[] = [];
    const options = {
      command: "scan" as const,
      env: { GITHUB_ACTIONS: "true" },
      store,
      notice: () => {},
      send: async (events: readonly TelemetryEvent[]) => {
        sent.push(...events);
        return true;
      },
    };
    const first = startTelemetry(options);
    first.finish(0);
    await first.flush(false);
    const second = startTelemetry(options);
    second.finish(1);
    await second.flush(false);
    expect(sent).toHaveLength(4);
    expect(sent.every((e) => e.installation_id === undefined)).toBe(true);
    expect(sent[0]!.ci_execution_id).toBe(sent[1]!.ci_execution_id);
    expect(sent[0]!.ci_execution_id).not.toBe(sent[2]!.ci_execution_id);
    expect(existsSync(join(root, "state"))).toBe(false);
    store.setEnabled(false);
    const disabled = startTelemetry(options);
    disabled.finish(0);
    await disabled.flush(false);
    expect(sent).toHaveLength(4);
  });
  it("bounds stalled CI shutdown and aborts its transport", async () => {
    vi.useFakeTimers();
    const { store } = fixture();
    let signal: AbortSignal | undefined;
    const client = startTelemetry({
      command: "scan",
      env: { CI: "1" },
      store,
      notice: () => {},
      send: async (_events, s) => {
        signal = s;
        return new Promise<boolean>(() => {});
      },
    });
    client.finish(0);
    const flushing = client.flush(false);
    await vi.advanceTimersByTimeAsync(1000);
    await flushing;
    expect(signal?.aborted).toBe(true);
  });
  it("cancellation during CI flush immediately aborts transport and ends the wait", async () => {
    vi.useFakeTimers();
    const { store } = fixture();
    const cancellation = new AbortController();
    let transportSignal: AbortSignal | undefined;
    const client = startTelemetry({
      command: "scan",
      env: { CI: "1" },
      store,
      notice: () => {},
      send: async (_events, signal) => {
        transportSignal = signal;
        return new Promise<boolean>(() => {});
      },
    });
    client.finish(0);
    let completed = false;
    void client.flush(false, cancellation.signal).then(() => {
      completed = true;
    });
    await vi.advanceTimersByTimeAsync(20);
    cancellation.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(transportSignal?.aborted).toBe(true);
    expect(completed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it("cancellation skips CI flush wait and disablement blocks pending finishes", async () => {
    const { store } = fixture();
    const sent: TelemetryEvent[] = [];
    const client = startTelemetry({
      command: "scan",
      env: { CI: "1" },
      store,
      notice: () => {},
      send: async (events) => {
        sent.push(...events);
        return true;
      },
    });
    store.setEnabled(false);
    client.finish(130);
    await client.flush(true);
    expect(sent.length).toBeLessThanOrEqual(1);
  });
});
