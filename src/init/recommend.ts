import { createHash } from "node:crypto";
import { applyEdits, modify, parse, type ParseError } from "jsonc-parser";
import { CHECK_IDS, type CheckId } from "../config/schema.js";
import type { Environment, RepositoryInspection } from "../inspection/types.js";
import type {
  CreateInitProposalOptions,
  InitFileChange,
  InitHookActivation,
  InitProposal,
  ResolvedHookChoice,
} from "./types.js";

function defaultHookActivation(hook: ResolvedHookChoice): InitHookActivation {
  if (hook === "none") {
    return Object.freeze({
      status: "not-requested",
      message: "No pre-commit integration was requested.",
    });
  }
  if (hook === "lefthook") {
    return Object.freeze({
      status: "pending",
      message:
        "Lefthook configuration will invoke Zedbee, but the Git hook is not activated by initialization.",
      remediation:
        "After reviewing the project tooling, run lefthook install to activate the configured hook.",
    });
  }
  if (hook === "simple-git-hooks") {
    return Object.freeze({
      status: "pending",
      message:
        "simple-git-hooks configuration will invoke Zedbee, but the Git hook is not activated by initialization.",
      remediation:
        "After reviewing the project tooling, run npx --no-install simple-git-hooks to activate the configured hook.",
    });
  }
  return Object.freeze({
    status: "active",
    message: `The proposed ${hook} hook directly invokes Zedbee.`,
  });
}

const COMMON_CHECKS = new Set<CheckId>([
  "formatting",
  "lint",
  "cyclomaticComplexity",
  "readabilityComplexity",
  "structuralSecurity",
  "secrets",
  "duplication",
  "deadCode",
]);
const PROFILE_CHECKS: Readonly<
  Record<CreateInitProposalOptions["profile"], ReadonlySet<CheckId>>
> = {
  fast: new Set([
    "formatting",
    "lint",
    "cyclomaticComplexity",
    "readabilityComplexity",
    "structuralSecurity",
    "reactCorrectness",
    "reactAccessibility",
  ]),
  recommended: new Set([
    "formatting",
    "lint",
    "types",
    "cyclomaticComplexity",
    "readabilityComplexity",
    "structuralSecurity",
    "secrets",
    "reactCorrectness",
    "reactAccessibility",
  ]),
  thorough: new Set(CHECK_IDS),
};
const ENVIRONMENT_ORDER: readonly Environment[] = [
  "javascript",
  "typescript",
  "react",
  "react-dom",
  "ink",
  "next",
  "remix",
  "vitest",
  "jest",
  "testing-library",
];

export function initContentHash(contents: string): string {
  return createHash("sha256").update(contents, "utf8").digest("hex");
}

export function exactFilePreview(
  relativePath: string,
  before: string | null,
  after: string,
): string {
  const previous = before ?? "";
  const beforeLines = previous.length === 0 ? [] : previous.split("\n");
  const afterLines = after.length === 0 ? [] : after.split("\n");
  return [
    `--- ${relativePath}`,
    `+++ ${relativePath}`,
    "@@ exact before / after @@",
    ...beforeLines.map((line) => `-${line}`),
    ...afterLines.map((line) => `+${line}`),
  ].join("\n");
}

export function initFileChange(
  relativePath: string,
  before: string | null,
  after: string,
  mode: number,
  absolutePath?: string,
): InitFileChange {
  return Object.freeze({
    relativePath,
    ...(absolutePath === undefined ? {} : { absolutePath }),
    before,
    after,
    beforeHash: before === null ? null : initContentHash(before),
    afterHash: initContentHash(after),
    diff: exactFilePreview(relativePath, before, after),
    mode,
  });
}

function configContents(
  profile: CreateInitProposalOptions["profile"],
  before: string | null,
  checks: readonly CheckId[] | undefined,
): string {
  const configuredChecks =
    checks === undefined
      ? undefined
      : Object.fromEntries(
          CHECK_IDS.map((check) => [
            check,
            checks.includes(check) ? "error" : "off",
          ]),
        );
  if (before === null) {
    return `${JSON.stringify(
      {
        $schema: "./node_modules/zedbee/schema/zedbee.schema.json",
        schemaVersion: 1,
        profile,
        ...(configuredChecks === undefined ? {} : { checks: configuredChecks }),
      },
      null,
      2,
    )}\n`;
  }
  const errors: ParseError[] = [];
  const parsed: unknown = parse(before, errors, { allowTrailingComma: true });
  if (
    errors.length > 0 ||
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed)
  ) {
    throw new Error(
      "Zedbee could not safely update the existing configuration.",
    );
  }
  const options = {
    formattingOptions: { insertSpaces: true, tabSize: 2, eol: "\n" },
  };
  let updated = before;
  updated = applyEdits(
    updated,
    modify(
      updated,
      ["$schema"],
      "./node_modules/zedbee/schema/zedbee.schema.json",
      options,
    ),
  );
  updated = applyEdits(updated, modify(updated, ["schemaVersion"], 1, options));
  updated = applyEdits(updated, modify(updated, ["profile"], profile, options));
  if (configuredChecks !== undefined) {
    updated = applyEdits(
      updated,
      modify(updated, ["checks"], configuredChecks, options),
    );
  }
  return updated.endsWith("\n") ? updated : `${updated}\n`;
}

function environments(
  inspection: RepositoryInspection,
): readonly Environment[] {
  const detected = new Set(
    inspection.workspaces.flatMap((workspace) => workspace.environments),
  );
  return Object.freeze(
    ENVIRONMENT_ORDER.filter((environment) => detected.has(environment)),
  );
}

function recommendedChecks(
  inspection: RepositoryInspection,
  detected: readonly Environment[],
  profile: CreateInitProposalOptions["profile"],
): readonly CheckId[] {
  const checks = new Set(COMMON_CHECKS);
  if (detected.includes("typescript")) checks.add("types");
  if (
    detected.some((environment) =>
      ["react", "react-dom", "ink", "next", "remix"].includes(environment),
    )
  ) {
    checks.add("reactCorrectness");
  }
  if (
    detected.some((environment) =>
      ["react-dom", "next", "remix"].includes(environment),
    )
  ) {
    checks.add("reactAccessibility");
  }
  if (inspection.workspaces.length > 1) checks.add("dependencyArchitecture");
  if (inspection.lockfiles.length > 0) checks.add("vulnerabilities");
  const profileChecks = PROFILE_CHECKS[profile];
  return Object.freeze(
    CHECK_IDS.filter((check) => checks.has(check) && profileChecks.has(check)),
  );
}

export function createInitProposal(
  inspection: RepositoryInspection,
  options: CreateInitProposalOptions,
): InitProposal {
  const detected = environments(inspection);
  const before = options.configBefore ?? null;
  const selectedChecks =
    options.checks === undefined
      ? recommendedChecks(inspection, detected, options.profile)
      : Object.freeze(
          CHECK_IDS.filter((check) => options.checks?.includes(check)),
        );
  const config = initFileChange(
    ".zedbeerc.jsonc",
    before,
    configContents(options.profile, before, options.checks),
    0o644,
  );
  const hook: ResolvedHookChoice =
    options.hook === "auto" ? "none" : options.hook;
  const hookActivation = options.hookActivation ?? defaultHookActivation(hook);
  const files = [
    config,
    ...(options.hookChange === undefined ? [] : [options.hookChange]),
  ];
  return Object.freeze({
    repositoryRoot: options.repositoryRoot,
    profile: options.profile,
    hook,
    hookActivation,
    detectedEnvironments: detected,
    recommendedChecks: selectedChecks,
    networkChecks:
      inspection.lockfiles.length === 0
        ? Object.freeze([])
        : Object.freeze([
            Object.freeze({
              id: "vulnerabilities" as const,
              usesNetwork: true,
              disclosure:
                "Online vulnerability checks send package names, versions, ecosystems, and supported file hashes to api.osv.dev and api.deps.dev; source code is not sent.",
            }),
          ]),
    limitations: Object.freeze([
      "Recommendations are based on inspected manifests, source extensions, workspaces, and lockfiles; review the exact proposal before applying it.",
      "Initialization never installs packages or runs project lifecycle scripts.",
      "Generated hooks use npx --no-install, so Zedbee must remain installed in the project.",
      ...(hookActivation.status === "pending" &&
      hookActivation.remediation !== undefined
        ? [hookActivation.remediation]
        : []),
    ]),
    files: Object.freeze(files),
  });
}
