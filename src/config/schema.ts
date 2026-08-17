import { z } from "zod";

export const CHECK_IDS = [
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
export const PROFILE_IDS = ["fast", "recommended", "thorough"] as const;

export type CheckId = (typeof CHECK_IDS)[number];
export type ProfileId = (typeof PROFILE_IDS)[number];
export type CheckSeverity = "off" | "warn" | "error";
export type CheckTiming = "relevant" | "always";
export type SourceExcerptPolicy = "never" | "interactive" | "always";

export interface ResolvedReportingPolicy {
  readonly sourceExcerpts: SourceExcerptPolicy;
}

export interface ResolvedCheckPolicy {
  severity: CheckSeverity;
  when: CheckTiming;
  max?: number;
  threshold?: number;
  blockWorsening?: boolean;
  onUnavailable?: "block" | "warn";
}

export type ResolvedCheckPolicyPatch = Readonly<Partial<ResolvedCheckPolicy>>;

export interface ResolvedPolicyOverride {
  files: readonly string[];
  checks: Readonly<Partial<Record<CheckId, ResolvedCheckPolicyPatch>>>;
}

export interface ResolvedConfig {
  schemaVersion: 1;
  profile: ProfileId;
  checks: Readonly<Record<CheckId, ResolvedCheckPolicy>>;
  overrides: readonly ResolvedPolicyOverride[];
  reporting: ResolvedReportingPolicy;
  failOnIncomplete: boolean;
  configPath?: string;
}

const checkSeveritySchema = z.enum(["off", "warn", "error"]).meta({
  description:
    "Whether a check is disabled, reports a warning, or blocks the commit.",
});
const checkTimingSchema = z.enum(["relevant", "always"]).meta({
  description:
    "Run only when staged changes are relevant, or run for every scan.",
  default: "relevant",
});
const positiveIntegerSchema = z.number().int().positive();
const percentageSchema = z.number().finite().min(0).max(100);

const commonPolicyFields = {
  severity: checkSeveritySchema.optional(),
  when: checkTimingSchema.optional(),
} as const;

const simplePolicyObjectSchema = z.object(commonPolicyFields).strict();
function complexityPolicyObjectSchema(defaultMaximum: number) {
  return z
    .object({
      ...commonPolicyFields,
      max: positiveIntegerSchema.optional().meta({
        description: "Maximum allowed complexity score.",
        default: defaultMaximum,
      }),
      blockWorsening: z.boolean().optional().meta({
        description:
          "Block newly introduced or increased complexity above the configured maximum.",
        default: true,
      }),
    })
    .strict();
}
const duplicationPolicyObjectSchema = z
  .object({
    ...commonPolicyFields,
    threshold: percentageSchema.optional().meta({
      description: "Maximum allowed duplicated-code percentage from 0 to 100.",
      default: 5,
    }),
  })
  .strict();
const vulnerabilityPolicyObjectSchema = z
  .object({
    ...commonPolicyFields,
    onUnavailable: z.enum(["block", "warn"]).optional().meta({
      description:
        "Block the commit or warn when the OSV service is temporarily unavailable.",
      default: "block",
    }),
  })
  .strict();

function policySchema<T extends z.ZodType>(objectSchema: T) {
  return z.union([checkSeveritySchema, objectSchema]);
}

const simplePolicySchema = policySchema(simplePolicyObjectSchema);
const cyclomaticComplexityPolicySchema = policySchema(
  complexityPolicyObjectSchema(20),
);
const readabilityComplexityPolicySchema = policySchema(
  complexityPolicyObjectSchema(15),
);
const duplicationPolicySchema = policySchema(duplicationPolicyObjectSchema);
const vulnerabilityPolicySchema = policySchema(vulnerabilityPolicyObjectSchema);

function describedPolicy<T extends z.ZodType>(schema: T, description: string) {
  return schema.optional().meta({ description });
}

const checksSchema = z
  .object({
    formatting: describedPolicy(
      simplePolicySchema,
      "Prettier formatting for changed JavaScript and TypeScript files.",
    ),
    lint: describedPolicy(
      simplePolicySchema,
      "ESLint correctness and maintainability findings in changed code.",
    ),
    types: describedPolicy(
      simplePolicySchema,
      "TypeScript type errors attributable to changed code.",
    ),
    cyclomaticComplexity: describedPolicy(
      cyclomaticComplexityPolicySchema,
      "Cyclomatic branch complexity; max defaults to 20 and can block worsening code.",
    ),
    readabilityComplexity: describedPolicy(
      readabilityComplexityPolicySchema,
      "Readability-oriented complexity; max defaults to 15 and can block worsening code.",
    ),
    structuralSecurity: describedPolicy(
      simplePolicySchema,
      "Semgrep-style structural security rules for changed code.",
    ),
    secrets: describedPolicy(
      simplePolicySchema,
      "Secretlint secret detection against the exact staged snapshot.",
    ),
    duplication: describedPolicy(
      duplicationPolicySchema,
      "Duplicated-code coverage; threshold is a percentage and defaults to 5.",
    ),
    dependencyArchitecture: describedPolicy(
      simplePolicySchema,
      "Dependency-cruiser architecture and import-boundary validation.",
    ),
    deadCode: describedPolicy(
      simplePolicySchema,
      "Unused files, exports, and dependencies reported by Knip.",
    ),
    reactCorrectness: describedPolicy(
      simplePolicySchema,
      "React and Hooks correctness validation for changed components.",
    ),
    reactAccessibility: describedPolicy(
      simplePolicySchema,
      "JSX accessibility validation for changed components.",
    ),
    vulnerabilities: describedPolicy(
      vulnerabilityPolicySchema,
      "Online OSV dependency vulnerability scanning with configurable outage handling.",
    ),
  })
  .strict();

const reportingSchema = z
  .object({
    sourceExcerpts: z.enum(["never", "interactive", "always"]).optional().meta({
      description:
        "Include exact staged source excerpts never, only in Ink, or in every report format.",
      default: "interactive",
    }),
  })
  .strict();

// Availability behavior is repository-wide because an outage affects the
// repository-wide OSV request rather than an individual file target.
const overrideChecksSchema = checksSchema.extend({
  vulnerabilities: simplePolicySchema.optional(),
});

const repositoryRelativeGlobSchema = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^\\]*$/, "Glob patterns must use forward slashes")
  .regex(/^(?!\/)/, "Glob patterns must be repository-relative")
  .regex(/^(?![A-Za-z]:)/, "Glob patterns must not use drive paths")
  .regex(
    /^(?!.*(?:^|\/)\.\.(?:\/|$))/,
    "Glob patterns must not traverse parent directories",
  )
  .regex(/^(?!(?:\.\/)+$)/, "Glob patterns must not be empty")
  .transform((pattern) => pattern.replace(/^(?:\.\/)+/, ""))
  .meta({
    description:
      "Repository-relative forward-slash glob selecting files for this override.",
  });

const policyOverrideSchema = z
  .object({
    files: z.array(repositoryRelativeGlobSchema).min(1).meta({
      description: "One or more repository-relative globs.",
    }),
    checks: overrideChecksSchema.meta({
      description:
        "Per-check policy patches. Vulnerability availability handling remains repository-wide.",
    }),
  })
  .strict();

export type CheckPolicyInput =
  z.infer<typeof simplePolicySchema> | ResolvedCheckPolicyPatch;

export const configFileSchema = z
  .object({
    $schema: z.string().optional().meta({
      description:
        "Optional editor schema reference, usually ./node_modules/zedbee/schema/zedbee.schema.json.",
    }),
    schemaVersion: z.literal(1).meta({
      description: "Configuration format version.",
      default: 1,
    }),
    profile: z.enum(PROFILE_IDS).optional().meta({
      description:
        "Base check suite. Per-check settings below override the selected profile.",
      default: "recommended",
    }),
    checks: checksSchema.optional().meta({
      description:
        "Repository-wide check policies, using severity shorthand or a policy object.",
      default: {},
    }),
    overrides: z.array(policyOverrideSchema).optional().meta({
      description:
        "Ordered file-scoped policy patches. Later matching overrides take precedence.",
      default: [],
    }),
    reporting: reportingSchema.optional(),
    failOnIncomplete: z.boolean().optional().meta({
      description:
        "Block the commit when a configured check cannot complete reliably.",
      default: true,
    }),
  })
  .strict()
  .meta({
    title: "Zedbee configuration",
    description:
      "Versioned policy for Zedbee diff-aware JavaScript and TypeScript pre-commit scans.",
  });

export type ConfigFile = z.infer<typeof configFileSchema>;
