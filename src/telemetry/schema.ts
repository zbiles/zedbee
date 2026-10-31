import { z } from "zod";
import { allowedFindingRule } from "./finding-rules.js";

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
export const telemetryV1EventSchema = z
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
    enabled_check_ids: z
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
        event.finding_count !== undefined ||
        event.enabled_check_ids !== undefined)
    )
      invalid();
    if (
      event.command !== "fix" &&
      (event.applied_count !== undefined || event.skipped_count !== undefined)
    )
      invalid();
    if (event.command !== "init" && event.hook !== undefined) invalid();
  });
export type TelemetryV1Event = z.infer<typeof telemetryV1EventSchema>;
export const AI_TOOLS = ["claude_code", "codex", "cursor"] as const;
const unique = <T>(values: T[]) => new Set(values).size === values.length;
const checkIds = z.array(z.enum(TELEMETRY_CHECK_IDS)).max(13).refine(unique);
const toolIds = z.array(z.enum(AI_TOOLS)).max(3).refine(unique);
export const findingGroupSchema = z
  .strictObject({
    check_id: z.enum(TELEMETRY_CHECK_IDS),
    rule_id: z.string().max(128),
    severity: z.enum(["info", "warning", "error"]),
    count: count.min(1),
  })
  .refine(
    (row) => allowedFindingRule(row.check_id, row.rule_id),
    "Unapproved finding rule",
  );
export const scanDetailsSchema = z
  .strictObject({
    finding_breakdown_version: z.literal(1),
    finding_breakdown_status: z.enum(["complete", "truncated", "unavailable"]),
    finding_groups: z.array(findingGroupSchema).max(256).optional(),
    finding_unmapped_count: count.optional(),
    finding_omitted_count: count.optional(),
    finding_counts_clipped: z.boolean().optional(),
    completed_check_ids: checkIds.optional(),
    ai_detection_version: z.literal(1),
    caller_ai_tool: z.enum([...AI_TOOLS, "unknown", "ambiguous"]),
    caller_ai_tool_candidates: toolIds,
    caller_ai_tool_source: z.enum(["none", "environment_hint"]),
    detected_ai_tools: toolIds,
    generic_agent_instructions_detected: z.boolean(),
    repo_ai_detection_status: z.enum(["complete", "partial", "unavailable"]),
  })
  .superRefine((details, ctx) => {
    const invalid = () =>
      ctx.addIssue({ code: "custom", message: "Invalid scan detail contract" });
    const fields = [
      details.finding_groups,
      details.finding_unmapped_count,
      details.finding_omitted_count,
      details.finding_counts_clipped,
      details.completed_check_ids,
    ];
    if (details.finding_breakdown_status === "unavailable") {
      if (fields.some((value) => value !== undefined)) invalid();
    } else {
      if (fields.some((value) => value === undefined)) invalid();
      if (
        details.finding_breakdown_status === "complete" &&
        (details.finding_unmapped_count !== 0 ||
          details.finding_omitted_count !== 0 ||
          details.finding_counts_clipped !== false)
      )
        invalid();
      const keys =
        details.finding_groups?.map((row) =>
          JSON.stringify([row.check_id, row.rule_id, row.severity]),
        ) ?? [];
      if (!unique(keys)) invalid();
      if (
        details.finding_breakdown_status === "truncated" &&
        !details.finding_counts_clipped &&
        details.finding_unmapped_count === 0 &&
        details.finding_omitted_count === 0
      )
        invalid();
    }
    const candidates = details.caller_ai_tool_candidates;
    const expected =
      candidates.length === 0
        ? "unknown"
        : candidates.length === 1
          ? candidates[0]
          : "ambiguous";
    if (
      details.caller_ai_tool !== expected ||
      details.caller_ai_tool_source !==
        (candidates.length ? "environment_hint" : "none")
    )
      invalid();
    if (new TextEncoder().encode(JSON.stringify(details)).byteLength > 16_384)
      invalid();
  });
export type ScanDetails = z.infer<typeof scanDetailsSchema>;
export type FindingGroup = z.infer<typeof findingGroupSchema>;
export const SCAN_DETAIL_KEYS = Object.keys(
  scanDetailsSchema.shape,
) as (keyof ScanDetails)[];
const telemetryV2EventSchema = z
  .strictObject({
    ...telemetryV1EventSchema.shape,
    ...scanDetailsSchema.shape,
    schema_version: z.literal(2),
    event: z.literal("scan_finished"),
    command: z.literal("scan"),
  })
  .superRefine((event, ctx) => {
    const legacy = Object.fromEntries(
      Object.keys(telemetryV1EventSchema.shape).map((key) => [
        key,
        event[key as keyof typeof event],
      ]),
    );
    legacy.schema_version = 1;
    const details = Object.fromEntries(
      SCAN_DETAIL_KEYS.map((key) => [key, event[key]]),
    );
    const invalid = () =>
      ctx.addIssue({
        code: "custom",
        message: "Invalid enriched scan contract",
      });
    if (
      !telemetryV1EventSchema.safeParse(legacy).success ||
      !scanDetailsSchema.safeParse(details).success
    )
      invalid();
    if (event.finding_breakdown_status === "unavailable") {
      if (event.finding_count !== undefined) invalid();
    } else if (event.finding_count === undefined) invalid();
    else if (event.finding_counts_clipped) {
      if (event.finding_count !== 1_000_000) invalid();
    } else if (
      (event.finding_groups ?? []).reduce(
        (total, row) => total + row.count,
        0,
      ) +
        (event.finding_unmapped_count ?? 0) +
        (event.finding_omitted_count ?? 0) !==
      event.finding_count
    )
      invalid();
  });
export const telemetryEventSchema = z.union([
  telemetryV1EventSchema,
  telemetryV2EventSchema,
]);
export type TelemetryEvent = z.infer<typeof telemetryEventSchema>;
export type TelemetryCommand = (typeof TELEMETRY_COMMANDS)[number];
export const telemetryBatchSchema = z.strictObject({
  events: z.array(telemetryEventSchema).min(1).max(20),
});
