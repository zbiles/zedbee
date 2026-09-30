import { afterEach, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { TelemetryStore } from "../../src/telemetry/state.js";
import { drainTelemetry } from "../../src/telemetry/worker.js";
import { telemetryEventSchema } from "../../src/telemetry/schema.js";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true }));
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telemetry-outbox-"));
  roots.push(root);
  const store = new TelemetryStore(join(root, "state"));
  store.initialize();
  return { store, root };
}
function event() {
  return telemetryEventSchema.parse({
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
}
function localEnvironment() {
  for (const name of [
    "ZEDBEE_TELEMETRY_DISABLED",
    "DO_NOT_TRACK",
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "ZEDBEE_TELEMETRY_CONTEXT",
  ])
    vi.stubEnv(name, "");
}
it("acknowledges sent IDs without losing events appended during sending", async () => {
  localEnvironment();
  const { store } = fixture();
  const a = event(),
    b = event();
  store.enqueue(a);
  let calls = 0;
  await drainTelemetry(store, new AbortController().signal, async (events) => {
    calls++;
    if (calls === 1) {
      expect(events[0]?.event_id).toBe(a.event_id);
      store.enqueue(b);
    }
    return true;
  });
  expect(calls).toBe(2);
  expect(store.pending()).toEqual([]);
});
it("leaves failed sends for later and respects an opt-out between batches", async () => {
  localEnvironment();
  const { store } = fixture();
  store.enqueue(event());
  await drainTelemetry(store, new AbortController().signal, async () => false);
  expect(store.pending()).toHaveLength(1);
  for (let i = 0; i < 25; i++) store.enqueue(event());
  let calls = 0;
  await drainTelemetry(store, new AbortController().signal, async () => {
    calls++;
    store.setEnabled(false);
    return true;
  });
  expect(calls).toBe(1);
  expect(store.read()?.events).toEqual([]);
});
it("never drains local events inside CI and refuses a concurrent sender", async () => {
  localEnvironment();
  const { store } = fixture();
  store.enqueue(event());
  let sends = 0;
  const send = async () => {
    sends++;
    return true;
  };
  vi.stubEnv("CI", "1");
  await drainTelemetry(store, new AbortController().signal, send);
  expect(sends).toBe(0);
  vi.stubEnv("CI", "");
  const release = store.lock("sender.lock");
  try {
    await drainTelemetry(store, new AbortController().signal, send);
  } finally {
    release();
  }
  expect(sends).toBe(0);
});
it("expires old outbox records before sending", () => {
  const { store, root } = fixture();
  const old = { ...event(), timestamp: "2020-01-01T00:00:00.000Z" };
  writeFileSync(
    join(root, "state", "state.json"),
    JSON.stringify({ ...store.read(), events: [old] }),
  );
  expect(store.pending()).toEqual([]);
  store.enqueue(event());
  expect(store.read()?.events).toHaveLength(1);
});
