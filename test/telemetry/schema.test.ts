import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  telemetryEventSchema,
  TELEMETRY_CHECK_IDS,
} from "../../src/telemetry/schema.js";
import {
  telemetryContext,
  telemetryDisabled,
} from "../../src/telemetry/policy.js";
import { CHECK_IDS } from "../../src/config/schema.js";

export function event(overrides: Record<string, unknown> = {}) {
  return {
    schema_version: 1,
    event: "scan_started",
    event_id: randomUUID(),
    run_id: randomUUID(),
    timestamp: new Date().toISOString(),
    version: "0.1.0-beta.3",
    os: "linux",
    arch: "x64",
    node_major: 24,
    command: "scan",
    environment: "ci_not_detected",
    invocation_source: "unspecified",
    installation_id: randomUUID(),
    scan_mode: "staged",
    output_format: "json",
    ...overrides,
  };
}
describe("telemetry contract", () => {
  it("accepts approved metadata and rejects arbitrary report content", () => {
    expect(telemetryEventSchema.safeParse(event()).success).toBe(true);
    for (const extra of [
      { path: "/private/repo" },
      { report: {} },
      { message: "secret" },
      { version: "/private/repo" },
      { os: "my-hostname" },
    ]) {
      expect(telemetryEventSchema.safeParse(event(extra)).success).toBe(false);
    }
    expect(TELEMETRY_CHECK_IDS).toEqual(CHECK_IDS);
  });
  it("accepts separate configured and executed check IDs with a bounded scan profile", () => {
    expect(
      telemetryEventSchema.safeParse(
        event({
          event: "scan_finished",
          outcome: "pass",
          duration_ms: 1,
          profile: "custom",
          enabled_check_ids: ["lint", "types"],
          check_ids: [],
        }),
      ).success,
    ).toBe(true);
    for (const enabled_check_ids of [["private-check"], ["lint", "lint"]]) {
      expect(
        telemetryEventSchema.safeParse(event({ enabled_check_ids })).success,
      ).toBe(false);
    }
    expect(
      telemetryEventSchema.safeParse(event({ profile: "private-profile" }))
        .success,
    ).toBe(false);
    expect(
      telemetryEventSchema.safeParse(
        event({
          event: "command_finished",
          command: "doctor",
          scan_mode: undefined,
          outcome: "completed",
          duration_ms: 1,
          enabled_check_ids: ["lint"],
        }),
      ).success,
    ).toBe(false);
  });
  it("prevents CI from carrying persistent local identities", () => {
    const ci = event({
      environment: "ci",
      ci_provider: "github_actions",
      ci_execution_id: randomUUID(),
    });
    expect(telemetryEventSchema.safeParse(ci).success).toBe(false);
    delete (ci as Record<string, unknown>).installation_id;
    expect(telemetryEventSchema.safeParse(ci).success).toBe(true);
    expect(
      telemetryEventSchema.safeParse(event({ event: "fix_finished" })).success,
    ).toBe(false);
    expect(
      telemetryEventSchema.safeParse(event({ duration_ms: Infinity })).success,
    ).toBe(false);
  });
});
describe("participation and context", () => {
  it.each([
    [{}, "ci_not_detected", undefined],
    [{ CI: "true" }, "ci", "generic"],
    [{ CI: " false " }, "ci_not_detected", undefined],
    [{ CI: "0", GITHUB_ACTIONS: "true" }, "ci", "github_actions"],
    [{ GITLAB_CI: "1" }, "ci", "gitlab_ci"],
    [{ GITHUB_ACTIONS: "true", GITLAB_CI: "true" }, "ci", "unknown"],
    [{ ZEDBEE_TELEMETRY_CONTEXT: "ci" }, "ci", "unknown"],
    [{ TERM: "dumb" }, "ci_not_detected", undefined],
  ])(
    "classifies flags without treating noninteractive terminals as CI",
    (env, environment, provider) => {
      const result = telemetryContext(env as Record<string, string>);
      expect(result.environment).toBe(environment);
      expect(result.ci_provider).toBe(provider);
    },
  );
  it("hard disable overrides apply even inside CI", () => {
    expect(telemetryDisabled({ CI: "true" })).toBe(false);
    expect(telemetryDisabled({ CI: "true", DO_NOT_TRACK: "1" })).toBe(true);
    expect(telemetryDisabled({ ZEDBEE_TELEMETRY_DISABLED: "1" })).toBe(true);
  });
});
