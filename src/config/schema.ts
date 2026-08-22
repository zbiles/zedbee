import { z } from "zod";
import { DISPLAY_TEXT_LIMITS, displayProse } from "../core/display-text.js";
import type { AgentGuidance } from "../reporting/agent-guidance.js";
import { parseTemporaryReportMaxAge } from "../reporting/report-age.js";
import {
  formattingSettingsSchema,
  type FormattingSettings,
} from "../checks/prettier/settings.js";
import {
  duplicationSettingsSchema,
  type DuplicationSettings,
} from "../checks/duplication/settings.js";
import {
  ManagedRuleConfigurationError,
  validateManagedRuleConfiguration,
  type RuleCheckId,
} from "../checks/eslint/rule-settings.js";
import type {
  EslintRuleConfiguration,
  ResolvedConfigurationOrigins,
} from "./settings-definition.js";

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
export type TerminalFindingLimit = number | "all";

export interface ResolvedReportingPolicy {
  readonly sourceExcerpts: SourceExcerptPolicy;
  readonly terminalFindingLimit: TerminalFindingLimit;
  readonly temporaryReportMaxAge: string;
  readonly agentGuidance: AgentGuidance;
}

export interface ResolvedCheckPolicyBase {
  severity: CheckSeverity;
  when: CheckTiming;
}

export interface ResolvedFormattingPolicy extends ResolvedCheckPolicyBase {
  settings: Readonly<FormattingSettings>;
}

export interface ResolvedDuplicationPolicy extends ResolvedCheckPolicyBase {
  threshold: number;
  settings: Readonly<DuplicationSettings>;
}

export interface ResolvedRulePolicy extends ResolvedCheckPolicyBase {
  rules: Readonly<Record<string, EslintRuleConfiguration>>;
}

export interface ResolvedComplexityPolicy extends ResolvedCheckPolicyBase {
  max: number;
  blockWorsening: boolean;
}

export interface ResolvedCheckPolicies {
  readonly formatting: ResolvedFormattingPolicy;
  readonly lint: ResolvedRulePolicy;
  readonly types: ResolvedCheckPolicyBase;
  readonly cyclomaticComplexity: ResolvedComplexityPolicy;
  readonly readabilityComplexity: ResolvedComplexityPolicy;
  readonly structuralSecurity: ResolvedCheckPolicyBase;
  readonly secrets: ResolvedCheckPolicyBase;
  readonly duplication: ResolvedDuplicationPolicy;
  readonly dependencyArchitecture: ResolvedCheckPolicyBase;
  readonly deadCode: ResolvedCheckPolicyBase;
  readonly reactCorrectness: ResolvedRulePolicy;
  readonly reactAccessibility: ResolvedRulePolicy;
  readonly vulnerabilities: ResolvedCheckPolicyBase & {
    onUnavailable: "block" | "warn";
  };
}

export type ResolvedCheckPolicy = ResolvedCheckPolicies[CheckId];

export type ResolvedCheckPolicyPatch = Readonly<
  Partial<ResolvedCheckPolicyBase> & {
    readonly max?: number;
    readonly threshold?: number;
    readonly blockWorsening?: boolean;
    readonly onUnavailable?: "block" | "warn";
    readonly settings?:
      Partial<FormattingSettings> | Partial<DuplicationSettings>;
    readonly rules?: Readonly<Record<string, EslintRuleConfiguration>>;
  }
>;

export interface ResolvedPolicyOverride {
  readonly files: readonly string[];
  readonly checks: Readonly<Partial<Record<CheckId, ResolvedCheckPolicyPatch>>>;
  readonly configurationOrigins: ResolvedConfigurationOrigins;
}

export interface ResolvedConfig {
  readonly schemaVersion: 1;
  readonly profile: ProfileId;
  readonly checks: Readonly<ResolvedCheckPolicies>;
  readonly overrides: readonly ResolvedPolicyOverride[];
  readonly reporting: Readonly<ResolvedReportingPolicy>;
  readonly configurationOrigins: ResolvedConfigurationOrigins;
  readonly failOnIncomplete: boolean;
  readonly configPath?: string;
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
const positiveSafeIntegerSchema = z.number().int().positive().safe();
const percentageSchema = z.number().finite().min(0).max(100);
const temporaryReportMaxAgeSchema = z
  .string()
  .regex(/^[1-9][0-9]{0,7}[mhd]$/u)
  .refine(
    (value) => {
      try {
        parseTemporaryReportMaxAge(value);
        return true;
      } catch {
        return false;
      }
    },
    {
      message:
        'Use a positive whole-number duration such as "30m", "24h", or "7d".',
    },
  );

const safeDisplayProsePattern = /^(?!.*[\p{Cc}\p{Cf}\u2028\u2029]).*$/u;
function safeDisplayProseSchema(field: string) {
  return z
    .string()
    .max(DISPLAY_TEXT_LIMITS.prose)
    .regex(safeDisplayProsePattern)
    .refine(
      (value) => {
        try {
          displayProse(value, field, { allowEmpty: true });
          return true;
        } catch {
          return false;
        }
      },
      { message: `Expected safe ${field} display text` },
    );
}

const commonPolicyFields = {
  severity: checkSeveritySchema.optional(),
  when: checkTimingSchema.optional(),
} as const;

const eslintRuleSeveritySchema = z.union([
  checkSeveritySchema,
  z.literal(0),
  z.literal(1),
  z.literal(2),
]);
const eslintRuleConfigurationSchema = z
  .union([
    eslintRuleSeveritySchema,
    z.tuple([eslintRuleSeveritySchema]).rest(z.unknown()),
  ])
  .meta({
    description:
      'ESLint rule severity ("off", "warn", "error", 0, 1, 2) or [severity, ...options].',
  });
const eslintRuleSettingsSchema = z
  .record(z.string().min(1), eslintRuleConfigurationSchema)
  .meta({
    description:
      "Managed rule overrides for known core, TypeScript ESLint, React, Hooks, or JSX accessibility rule IDs.",
  });

const simplePolicyObjectSchema = z.object(commonPolicyFields).strict();
function rulePolicyObjectSchema(checkId: RuleCheckId) {
  return z
    .object({
      ...commonPolicyFields,
      rules: eslintRuleSettingsSchema.optional(),
    })
    .strict()
    .superRefine((policy, context) => {
      if (policy.rules === undefined) return;
      try {
        validateManagedRuleConfiguration(checkId, policy.rules);
      } catch (error) {
        context.addIssue({
          code: "custom",
          message: error instanceof Error ? error.message : "Invalid rules",
          path:
            error instanceof ManagedRuleConfigurationError &&
            error.ruleId !== undefined
              ? ["rules", error.ruleId]
              : ["rules"],
        });
      }
    });
}
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
    settings: duplicationSettingsSchema.partial().strict().optional(),
  })
  .strict();
const formattingPolicyObjectSchema = z
  .object({
    ...commonPolicyFields,
    settings: formattingSettingsSchema.partial().strict().optional(),
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
const lintPolicySchema = policySchema(rulePolicyObjectSchema("lint"));
const reactCorrectnessPolicySchema = policySchema(
  rulePolicyObjectSchema("reactCorrectness"),
);
const reactAccessibilityPolicySchema = policySchema(
  rulePolicyObjectSchema("reactAccessibility"),
);
const formattingPolicySchema = policySchema(formattingPolicyObjectSchema);
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
      formattingPolicySchema,
      "Prettier formatting for changed JavaScript and TypeScript files.",
    ),
    lint: describedPolicy(
      lintPolicySchema,
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
      reactCorrectnessPolicySchema,
      "React and Hooks correctness validation for changed components.",
    ),
    reactAccessibility: describedPolicy(
      reactAccessibilityPolicySchema,
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
    terminalFindingLimit: z
      .union([positiveSafeIntegerSchema, z.literal("all")])
      .optional()
      .meta({
        description:
          'Maximum findings presented automatically in terminal output; use "all" to present every finding.',
        default: 25,
      }),
    temporaryReportMaxAge: temporaryReportMaxAgeSchema.optional().meta({
      description:
        'Maximum temporary-report age as a whole-number duration ending in "m", "h", or "d".',
      default: "24h",
    }),
    agentGuidance: z
      .object({
        opening: safeDisplayProseSchema("agent guidance opening").optional(),
        nextStep: safeDisplayProseSchema("agent guidance next step").optional(),
      })
      .strict()
      .optional()
      .meta({
        description:
          "Optional terminal-safe guidance for agents reviewing automatic scan results.",
      }),
  })
  .strict();

// Availability behavior and duplication settings are repository/workspace-wide
// because neither can vary safely for an individual file target.
const overrideChecksSchema = checksSchema.extend({
  duplication: simplePolicySchema.optional(),
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
        "Per-check policy patches. Duplication thresholds/settings and vulnerability availability handling remain repository-wide.",
    }),
  })
  .strict();

export type CheckPolicyInput =
  | z.infer<typeof simplePolicySchema>
  | z.infer<typeof lintPolicySchema>
  | z.infer<typeof reactCorrectnessPolicySchema>
  | z.infer<typeof reactAccessibilityPolicySchema>
  | z.infer<typeof formattingPolicySchema>
  | z.infer<typeof cyclomaticComplexityPolicySchema>
  | z.infer<typeof readabilityComplexityPolicySchema>
  | z.infer<typeof duplicationPolicySchema>
  | z.infer<typeof vulnerabilityPolicySchema>;

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
