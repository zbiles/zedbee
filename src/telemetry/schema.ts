import { z } from "zod";

// Self-contained wire contract, also vendored and checked by the private collector.
export const TELEMETRY_CHECK_IDS = [
  "formatting",
  "lint",
  "types",
  "cyclomaticComplexity",
  "readabilityComplexity",
  "structuralSecurity",
  "secrets",
  "duplication",
  "dependencyArchitecture",
  "deadCode",
  "reactCorrectness",
  "reactAccessibility",
  "vulnerabilities",
] as const;
export const TELEMETRY_COMMANDS = [
  "scan",
  "fix",
  "init",
  "checks",
  "doctor",
] as const;
export const TELEMETRY_EVENTS = [
  "scan_started",
  "scan_finished",
  "fix_finished",
  "setup_finished",
  "command_finished",
] as const;
const count = z.number().int().min(0).max(1_000_000);
const identity = z.string().uuid();
export const telemetryEventSchema = z
  .strictObject({
    schema_version: z.literal(1),
    event: z.enum(TELEMETRY_EVENTS),
    event_id: identity,
    run_id: identity,
    timestamp: z.string().datetime(),
    version: z
      .string()
      .max(80)
      .regex(/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?(?:\+[a-zA-Z0-9.-]+)?$/u),
    os: z.enum(["darwin", "linux", "win32", "other"]),
    arch: z.enum(["x64", "arm64", "ia32", "arm", "other"]),
    node_major: z.number().int().min(1).max(1000),
    command: z.enum(TELEMETRY_COMMANDS),
    environment: z.enum(["ci", "ci_not_detected"]),
    invocation_source: z.enum(["git_hook", "unspecified"]),
    installation_id: identity.optional(),
    ci_execution_id: identity.optional(),
    ci_provider: z
      .enum(["github_actions", "gitlab_ci", "generic", "unknown"])
      .optional(),
    scan_mode: z.enum(["staged", "base"]).optional(),
    output_format: z.enum(["auto", "ink", "text", "json", "sarif"]).optional(),
    outcome: z
      .enum([
        "pass",
        "blocked",
        "incomplete",
        "cancelled",
        "completed",
        "preview",
        "applied",
      ])
      .optional(),
    duration_ms: z.number().int().min(0).max(604_800_000).optional(),
    empty_input: z.boolean().optional(),
    check_ids: z
      .array(z.enum(TELEMETRY_CHECK_IDS))
      .max(13)
      .refine((v) => new Set(v).size === v.length)
      .optional(),
    finding_count: count.optional(),
    applied_count: count.optional(),
    skipped_count: count.optional(),
    profile: z.enum(["fast", "recommended", "thorough", "custom"]).optional(),
    hook: z
      .enum([
        "auto",
        "tracked",
        "husky",
        "lefthook",
        "simple-git-hooks",
        "raw",
        "none",
        "custom",
      ])
      .optional(),
  })
  .superRefine((event, ctx) => {
    const invalid = () =>
      ctx.addIssue({ code: "custom", message: "Invalid telemetry contract" });
    if (event.environment === "ci") {
      if (!event.ci_execution_id || !event.ci_provider || event.installation_id)
        invalid();
    } else if (
      !event.installation_id ||
      event.ci_execution_id ||
      event.ci_provider
    )
      invalid();
    const expected = event.event.startsWith("scan_")
      ? "scan"
      : event.event === "fix_finished"
        ? "fix"
        : event.event === "setup_finished"
          ? "init"
          : undefined;
    if (
      expected
        ? event.command !== expected
        : !["checks", "doctor"].includes(event.command)
    )
      invalid();
    if (event.event === "scan_started") {
      if (
        event.outcome !== undefined ||
        event.duration_ms !== undefined ||
        event.scan_mode === undefined
      )
        invalid();
    } else if (event.outcome === undefined || event.duration_ms === undefined)
      invalid();
    const outcomes =
      event.event === "scan_finished"
        ? ["pass", "blocked", "incomplete", "cancelled"]
        : event.event === "fix_finished"
          ? ["preview", "applied", "incomplete", "cancelled"]
          : event.event === "setup_finished"
            ? ["completed", "preview", "cancelled", "incomplete"]
            : ["completed", "incomplete", "cancelled"];
    if (event.outcome !== undefined && !outcomes.includes(event.outcome))
      invalid();
    if (
      event.command !== "scan" &&
      (event.scan_mode !== undefined ||
        event.empty_input !== undefined ||
        event.finding_count !== undefined)
    )
      invalid();
    if (
      event.command !== "fix" &&
      (event.applied_count !== undefined || event.skipped_count !== undefined)
    )
      invalid();
    if (event.command !== "init" && event.hook !== undefined) invalid();
  });
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export type TelemetryCommand = (typeof TELEMETRY_COMMANDS)[number];
export const telemetryBatchSchema = z.strictObject({
  events: z.array(telemetryEventSchema).min(1).max(20),
});
