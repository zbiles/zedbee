import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  readFileSync,
  writeFileSync,
  symlinkSync,
  existsSync,
  utimesSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TelemetryStore } from "../../src/telemetry/state.js";
import { telemetryEventSchema } from "../../src/telemetry/schema.js";
import { randomUUID } from "node:crypto";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "telemetry-state-"));
  roots.push(root);
  return { root, store: new TelemetryStore(join(root, "state")) };
}
afterEach(() =>
  roots.splice(0).forEach((p) => rmSync(p, { recursive: true, force: true })),
);
function sample() {
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
describe("private telemetry state", () => {
  it("status is read-only; identity and opt-out survive another store instance", () => {
    const { root, store } = fixture();
    expect(store.read()).toBeUndefined();
    expect(existsSync(join(root, "state"))).toBe(false);
    const initial = store.initialize();
    expect(initial.enabled).toBe(true);
    store.enqueue(sample());
    store.setEnabled(false);
    const reopened = new TelemetryStore(join(root, "state"));
    expect(reopened.read()).toMatchObject({
      enabled: false,
      installation_id: initial.installation_id,
      events: [],
    });
    reopened.enqueue(sample());
    expect(reopened.read()?.events).toEqual([]);
  });
  it("keeps the installation identity stable when initialized again", () => {
    const { store } = fixture();
    const first = store.initialize();
    expect(store.initialize().installation_id).toBe(first.installation_id);
  });
  it("bounds the outbox and acknowledges only delivered IDs", () => {
    const { store } = fixture();
    store.initialize();
    for (let i = 0; i < 104; i++) store.enqueue(sample());
    const events = store.pending();
    expect(events).toHaveLength(100);
    const later = sample();
    store.enqueue(later);
    store.acknowledge(events.slice(0, 20).map((e) => e.event_id));
    expect(store.pending().some((e) => e.event_id === later.event_id)).toBe(
      true,
    );
    expect(
      store.pending().some((e) => e.event_id === events[19]!.event_id),
    ).toBe(false);
  });
  it("rejects corrupt preferences and symlinked state without overwriting targets", () => {
    const { root, store } = fixture();
    store.initialize();
    const path = join(root, "state", "state.json");
    writeFileSync(path, "broken");
    expect(() => store.initialize()).toThrow();
    expect(readFileSync(path, "utf8")).toBe("broken");
    rmSync(path);
    const target = join(root, "target");
    writeFileSync(target, "private");
    symlinkSync(target, path);
    expect(() => store.setEnabled(false)).toThrow();
    expect(readFileSync(target, "utf8")).toBe("private");
  });
});

it("never lets competing stale-lock recovery delete a new owner's lock", () => {
  const { root, store } = fixture();
  store.initialize();
  const path = join(root, "state", "state.lock");
  writeFileSync(path, "99999999", { mode: 0o600 });
  utimesSync(path, new Date(0), new Date(0));
  let nested = false;
  const owners: Array<() => void> = [];
  const spy = vi.spyOn(process, "kill").mockImplementation(() => {
    if (!nested) {
      nested = true;
      try {
        owners.push(store.lock());
      } catch {}
    }
    throw Object.assign(new Error("dead process"), { code: "ESRCH" });
  });
  try {
    try {
      owners.push(store.lock());
    } catch {}
    expect(owners).toHaveLength(1);
  } finally {
    spy.mockRestore();
    owners.forEach((release) => release());
  }
});
