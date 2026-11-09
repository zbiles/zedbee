import { fitScanDetails } from "../../src/telemetry/finding-summary.js";
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
  TELEMETRY_CHECK_IDS,
  type ScanDetails,
} from "../../src/telemetry/schema.js";
import { telemetryBatches } from "../../src/telemetry/batch.js";
import { drainTelemetry } from "../../src/telemetry/worker.js";
import { findingCatalog } from "../../src/telemetry/finding-catalog.js";
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
it("keeps v2 details out of the ordinary v1 event queue and enriches only pending parent events", async () => {
  const { store, event, sidecars } = fixture();
  sidecars.write(event, details);
  store.enqueue(event);
  expect(
    JSON.parse(readFileSync(join(store.directory, "state-v2.json"), "utf8"))
      .state.events[0].schema_version,
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
  mkdirSync(sidecars.path, { mode: 0o700 });
  const target = join(root, "private");
  writeFileSync(target, "PRIVATE", { mode: 0o600 });
  symlinkSync(target, join(sidecars.path, `${event.event_id}.json`));
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
  const groups = Object.keys(findingCatalog.types!)
    .slice(0, 100)
    .map((rule_id) => ({
      check_id: "types" as const,
      rule_id,
      severity: "error" as const,
      count: 1,
    }));
  const largeDetails = {
    ...details,
    finding_groups: groups,
    completed_check_ids: ["types" as const],
  };
  const events = Array.from({ length: 60 }, () =>
    enrichTelemetryEvent(
      { ...event, finding_count: 100, event_id: randomUUID() },
      largeDetails,
    ),
  );
  expect(events.every((event) => event.schema_version === 2)).toBe(true);
  const batches = telemetryBatches(events);
  expect(batches.length).toBeGreaterThan(3);
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

it("persists and drains optional v3 diagnostics alongside legacy parent events", async () => {
  const { store, event } = fixture();
  const performance = {
    performance_version: 1,
    performance_status: "complete",
    changed_file_count_bucket: "1",
    change_category: "unknown",
    execution_mode: "none",
    check_performance: [],
    incomplete_reasons: [],
    incomplete_reasons_omitted: 0,
  } as const;
  const detailsStore = new TelemetryDetailsStore(store.directory);
  detailsStore.write(event, details, {
    ...performance,
    check_performance: [],
    incomplete_reasons: [],
  });
  store.enqueue(event);
  let sent: unknown;
  await drainTelemetry(store, new AbortController().signal, async (events) => {
    sent = events[0];
    return true;
  });
  expect(sent).toMatchObject({
    schema_version: 3,
    performance_status: "complete",
    finding_groups: details.finding_groups,
  });
  expect(store.pending()).toEqual([]);
});

it("retains a partial v3 header when saturated findings require trimming diagnostic rows", () => {
  const { store, event } = fixture();
  const groups = Object.keys(findingCatalog.types!)
    .slice(0, 256)
    .map((rule_id) => ({
      check_id: "types" as const,
      rule_id,
      severity: "error" as const,
      count: 1,
    }));
  const large = fitScanDetails({
    ...details,
    finding_groups: groups,
    completed_check_ids: ["types" as const],
  });
  const performance = {
    performance_version: 1 as const,
    performance_status: "complete" as const,
    changed_file_count_bucket: "1" as const,
    change_category: "unknown" as const,
    execution_mode: "local" as const,
    check_performance: [],
    incomplete_reasons: [],
    incomplete_reasons_omitted: 0,
  };
  const rows = Array.from({ length: 13 }, (_, i) => ({
    check_id: TELEMETRY_CHECK_IDS[i]!,
    task_count: 1000000,
    elapsed_sum_ms: 604800000,
    elapsed_max_ms: 604800000,
    queue_sum_ms: 604800000,
    queue_max_ms: 604800000,
    worker_sum_ms: 604800000,
    worker_max_ms: 604800000,
    cache_hits: 1000000,
    cache_misses: 1000000,
    cache_bypasses: 1000000,
  }));
  const ds = new TelemetryDetailsStore(store.directory);
  ds.write({ ...event, finding_count: groups.length }, large, {
    ...performance,
    check_performance: rows,
  });
  const wire = enrichTelemetryEvent(
    { ...event, finding_count: groups.length },
    ds.read(event),
  );
  expect(wire).toMatchObject({
    schema_version: 3,
    performance_status: "partial",
    finding_groups: large.finding_groups,
  });
});
