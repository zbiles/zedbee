import { afterEach, expect, it, vi } from "vitest";
import {
  mkdtempSync,
  rmSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  TelemetryDetailsStore,
  enrichTelemetryEvent,
} from "../../src/telemetry/details-store.js";
import { TelemetryStore } from "../../src/telemetry/state.js";
import {
  telemetryV1EventSchema,
  type ScanDetails,
} from "../../src/telemetry/schema.js";
import { telemetryBatches } from "../../src/telemetry/batch.js";
import { drainTelemetry } from "../../src/telemetry/worker.js";
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  roots
    .splice(0)
    .forEach((root) => rmSync(root, { recursive: true, force: true }));
});
const details: ScanDetails = {
  finding_breakdown_version: 1,
  finding_breakdown_status: "complete",
  finding_groups: [
    {
      check_id: "lint",
      rule_id: "no-unused-vars",
      severity: "error",
      count: 1,
    },
  ],
  finding_unmapped_count: 0,
  finding_omitted_count: 0,
  finding_counts_clipped: false,
  completed_check_ids: ["lint"],
  ai_detection_version: 1,
  caller_ai_tool: "unknown",
  caller_ai_tool_candidates: [],
  caller_ai_tool_source: "none",
  detected_ai_tools: ["cursor"],
  generic_agent_instructions_detected: false,
  repo_ai_detection_status: "complete",
};
function fixture() {
  for (const name of [
    "ZEDBEE_TELEMETRY_DISABLED",
    "DO_NOT_TRACK",
    "CI",
    "GITHUB_ACTIONS",
    "GITLAB_CI",
    "ZEDBEE_TELEMETRY_CONTEXT",
  ])
    vi.stubEnv(name, "");
  const root = mkdtempSync(join(tmpdir(), "telemetry-details-"));
  roots.push(root);
  const store = new TelemetryStore(join(root, "state"));
  const initial = store.initialize();
  const event = telemetryV1EventSchema.parse({
    schema_version: 1,
    event: "scan_finished",
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
    installation_id: initial.installation_id,
    outcome: "blocked",
    duration_ms: 1,
    finding_count: 1,
  });
  return {
    root,
    store,
    event,
    sidecars: new TelemetryDetailsStore(store.directory),
  };
}
it("keeps v2 details out of legacy state and enriches only pending parent events", async () => {
  const { store, event, sidecars } = fixture();
  sidecars.write(event, details);
  store.enqueue(event);
  expect(
    JSON.parse(readFileSync(join(store.directory, "state.json"), "utf8"))
      .events[0].schema_version,
  ).toBe(1);
  const sent: unknown[] = [];
  await drainTelemetry(store, new AbortController().signal, async (events) => {
    sent.push(...events);
    return true;
  });
  expect(sent).toMatchObject([
    {
      schema_version: 2,
      event_id: event.event_id,
      detected_ai_tools: ["cursor"],
      finding_groups: [{ rule_id: "no-unused-vars", count: 1 }],
    },
  ]);
  expect(store.pending()).toEqual([]);
  expect(sidecars.read(event)).toBeUndefined();
});
it("cannot resurrect orphan details after an old client's disable/enable clears parents", async () => {
  const { store, event, sidecars } = fixture();
  sidecars.write(event, details);
  store.enqueue(event);
  store.setEnabled(false);
  store.setEnabled(true);
  let sends = 0;
  await drainTelemetry(store, new AbortController().signal, async () => {
    sends++;
    return true;
  });
  expect(sends).toBe(0);
});
it("rejects linked sidecar files without reading or changing their targets", () => {
  const { root, store, event, sidecars } = fixture();
  mkdirSync(join(store.directory, "details"), { mode: 0o700 });
  const target = join(root, "private");
  writeFileSync(target, "PRIVATE", { mode: 0o600 });
  symlinkSync(
    target,
    join(store.directory, "details", `${event.event_id}.json`),
  );
  expect(sidecars.read(event)).toBeUndefined();
  sidecars.clear();
  expect(readFileSync(target, "utf8")).toBe("PRIVATE");
});
it("falls back to v1 for missing or inconsistent enrichment", () => {
  const { event } = fixture();
  expect(enrichTelemetryEvent(event).schema_version).toBe(1);
  expect(
    enrichTelemetryEvent(event, { ...details, finding_groups: [] })
      .schema_version,
  ).toBe(1);
});
it("packs enriched events by serialized bytes and count with stable identities", () => {
  const { event } = fixture();
  const events = Array.from({ length: 60 }, () =>
    enrichTelemetryEvent({ ...event, event_id: randomUUID() }, details),
  );
  const batches = telemetryBatches(events);
  expect(batches.flat().map((row) => row.event_id)).toEqual(
    events.map((row) => row.event_id),
  );
  for (const batch of batches) {
    expect(batch.length).toBeLessThanOrEqual(20);
    expect(
      Buffer.byteLength(JSON.stringify({ events: batch })),
    ).toBeLessThanOrEqual(60 * 1024);
  }
});
