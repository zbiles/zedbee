import type {
  CheckAdapter,
  ExecutionClass,
  InspectionContext,
} from "../checks/adapter.js";
import { loadConfig } from "../config/load-config.js";
import {
  CHECK_IDS,
  type CheckId,
  type ResolvedConfig,
} from "../config/schema.js";
import { compareCodeUnits } from "../core/compare.js";
import { readStagedChangeSet } from "../git/change-set.js";
import { GitClient } from "../git/client.js";
import { buildSnapshotPair } from "../git/snapshot.js";
import { inspectRepository } from "../inspection/inspect-repository.js";
import { DEFAULT_CHECK_ADAPTERS } from "../scan/run-scan.js";

export type ChecksOutputFormat = "text" | "json";

export interface ChecksCommandOptions {
  readonly cwd: string;
  readonly format: ChecksOutputFormat;
  readonly configPath?: string;
}

export interface ChecksCommandIO {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

export interface CheckApplicabilityDescription {
  readonly applicable: boolean;
  readonly targets: readonly string[];
  readonly executionClass: ExecutionClass;
  readonly reason?: string;
}

export interface CheckDescription {
  readonly id: CheckId;
  readonly description: string;
  readonly severity: string;
  readonly timing: string;
  readonly applicability: "applicable" | "not-applicable";
  readonly targets: readonly string[];
  readonly executionClass: ExecutionClass;
  readonly network: "none" | "online-package-metadata-only";
  readonly engine: {
    readonly name: string;
    readonly version: string;
    readonly license: string;
  };
  readonly limitation: string;
  readonly reason?: string;
}

export interface ChecksCommandResult {
  readonly exitCode: 0 | 2;
  readonly checks: readonly CheckDescription[];
}

export interface ChecksCommandDependencies {
  resolveRepositoryRoot(cwd: string): Promise<string>;
  loadConfig(
    repositoryRoot: string,
    configPath?: string,
  ): Promise<ResolvedConfig>;
  inspectChecks(
    repositoryRoot: string,
    config: ResolvedConfig,
  ): Promise<ReadonlyMap<CheckId, CheckApplicabilityDescription>>;
}

interface CatalogEntry {
  readonly description: string;
  readonly engine: CheckDescription["engine"];
  readonly executionClass: ExecutionClass;
  readonly limitation: string;
}

const eslint = { name: "ESLint", version: "9.39.5", license: "MIT" } as const;
const CATALOG: Readonly<Record<CheckId, CatalogEntry>> = Object.freeze({
  formatting: {
    description: "Checks staged formatting.",
    engine: { name: "Prettier", version: "3.9.6", license: "MIT" },
    executionClass: "lightweight",
    limitation:
      "Reports formatting differences; it does not rewrite the index.",
  },
  lint: {
    description: "Checks JavaScript and TypeScript correctness rules.",
    engine: eslint,
    executionClass: "project-analysis",
    limitation:
      "Uses Zedbee's managed rules and never loads project ESLint configuration.",
  },
  types: {
    description: "Checks TypeScript diagnostics in the staged workspace.",
    engine: { name: "TypeScript", version: "6.0.3", license: "Apache-2.0" },
    executionClass: "project-analysis",
    limitation:
      "Requires a contained tsconfig.json and does not invent compiler settings.",
  },
  cyclomaticComplexity: {
    description: "Detects worsened cyclomatic complexity.",
    engine: eslint,
    executionClass: "lightweight",
    limitation:
      "Measures syntax-level branch complexity, not runtime behavior.",
  },
  readabilityComplexity: {
    description: "Detects worsened readability complexity.",
    engine: { name: "ESLint + Zedbee rule", version: "9.39.5", license: "MIT" },
    executionClass: "lightweight",
    limitation:
      "This managed heuristic is intentionally not a Sonar Cognitive Complexity implementation.",
  },
  structuralSecurity: {
    description: "Finds high-confidence insecure JavaScript structures.",
    engine: { name: "ast-grep", version: "0.45.1", license: "MIT" },
    executionClass: "lightweight",
    limitation:
      "The built-in rules do not provide Semgrep-style taint, inter-file, or framework analysis.",
  },
  secrets: {
    description: "Finds secrets in the exact staged snapshot.",
    engine: { name: "Secretlint", version: "13.0.4", license: "MIT" },
    executionClass: "project-analysis",
    limitation:
      "Scans changed regular UTF-8 files up to 1 MiB, not repository history; pattern matches can require human confirmation.",
  },
  duplication: {
    description: "Detects new and enlarged code clones.",
    engine: { name: "jscpd", version: "5.0.15", license: "MIT" },
    executionClass: "project-analysis",
    limitation:
      "Baseline comparison runs project analysis twice and small clones below managed thresholds are omitted.",
  },
  dependencyArchitecture: {
    description: "Detects new dependency graph violations.",
    engine: { name: "dependency-cruiser", version: "18.2.0", license: "MIT" },
    executionClass: "project-analysis",
    limitation:
      "Dynamic dependency construction can evade static graph resolution.",
  },
  deadCode: {
    description: "Detects newly unused code and dependency hygiene issues.",
    engine: { name: "Knip", version: "6.32.2", license: "ISC" },
    executionClass: "project-analysis",
    limitation:
      "Dynamic imports and framework conventions may need future managed profiles.",
  },
  reactCorrectness: {
    description: "Checks React and Hooks correctness.",
    engine: {
      name: "ESLint React plugins",
      version: "7.37.5 / 7.1.1",
      license: "MIT",
    },
    executionClass: "lightweight",
    limitation:
      "Uses managed React 19.2 settings rather than project executable configuration.",
  },
  reactAccessibility: {
    description: "Checks JSX accessibility for DOM React workspaces.",
    engine: {
      name: "eslint-plugin-jsx-a11y",
      version: "6.10.2",
      license: "MIT",
    },
    executionClass: "lightweight",
    limitation:
      "Static JSX rules cannot prove the accessibility of runtime interaction.",
  },
  vulnerabilities: {
    description: "Checks dependency lockfiles for known vulnerabilities.",
    engine: {
      name: "Zedbee OSV API client",
      version: "v1",
      license: "PolyForm-Small-Business-1.0.0",
    },
    executionClass: "network",
    limitation:
      "Online-only results depend on OSV availability, advisory freshness, and supported JavaScript lockfile data.",
  },
});

async function inspectConfiguredChecks(
  repositoryRoot: string,
  config: ResolvedConfig,
): Promise<ReadonlyMap<CheckId, CheckApplicabilityDescription>> {
  const git = new GitClient(repositoryRoot);
  const changeSet = await readStagedChangeSet(git);
  const snapshots = await buildSnapshotPair(repositoryRoot, git);
  try {
    const [baselineInspection, targetInspection] = await Promise.all([
      inspectRepository(snapshots.baselineDir),
      inspectRepository(snapshots.targetDir),
    ]);
    const context: InspectionContext = {
      repositoryRoot,
      changeSet,
      config,
      baselineInspection,
      targetInspection,
    };
    const entries = await Promise.all(
      DEFAULT_CHECK_ADAPTERS.map(async (adapter: CheckAdapter) => {
        const applicability = await adapter.inspect(context);
        const id = adapter.id as CheckId;
        return [
          id,
          applicability.applies
            ? {
                applicable: true,
                targets: applicability.targets
                  .map(({ id: targetId }) => targetId)
                  .sort(compareCodeUnits),
                executionClass: applicability.executionClass,
              }
            : {
                applicable: false,
                targets: [],
                executionClass: CATALOG[id].executionClass,
                reason: applicability.reason,
              },
        ] as const;
      }),
    );
    return new Map(entries);
  } finally {
    await snapshots.cleanup();
  }
}

const DEFAULT_DEPENDENCIES: ChecksCommandDependencies = {
  async resolveRepositoryRoot(cwd) {
    return (await new GitClient(cwd).run(["rev-parse", "--show-toplevel"]))
      .stdout;
  },
  loadConfig,
  inspectChecks: inspectConfiguredChecks,
};

function renderText(result: ChecksCommandResult): string {
  return `${result.checks
    .map((check) => {
      const targets =
        check.targets.length === 0 ? "none" : check.targets.join(", ");
      return `${check.id} [${check.severity}/${check.timing}] ${check.applicability}; ${check.executionClass}; targets: ${targets}; engine: ${check.engine.name} ${check.engine.version} (${check.engine.license}); network: ${check.network}\n  ${check.description}\n  Limitation: ${check.limitation}${check.reason === undefined ? "" : `\n  Reason: ${check.reason}`}`;
    })
    .join("\n")}\n`;
}

export async function executeChecksCommand(
  options: ChecksCommandOptions,
  io: ChecksCommandIO,
  dependencies: ChecksCommandDependencies = DEFAULT_DEPENDENCIES,
): Promise<ChecksCommandResult> {
  try {
    const repositoryRoot = await dependencies.resolveRepositoryRoot(
      options.cwd,
    );
    const config = await dependencies.loadConfig(
      repositoryRoot,
      options.configPath,
    );
    const applicability = await dependencies.inspectChecks(
      repositoryRoot,
      config,
    );
    const checks = Object.freeze(
      CHECK_IDS.map((id): CheckDescription => {
        const runtime = applicability.get(id) ?? {
          applicable: false,
          targets: [],
          executionClass: CATALOG[id].executionClass,
          reason: "Check applicability was not reported.",
        };
        const policy = config.checks[id];
        return Object.freeze({
          id,
          description: CATALOG[id].description,
          severity: policy.severity,
          timing: policy.when,
          applicability: runtime.applicable ? "applicable" : "not-applicable",
          targets: Object.freeze([...runtime.targets]),
          executionClass: runtime.executionClass,
          network:
            id !== "vulnerabilities" ? "none" : "online-package-metadata-only",
          engine: Object.freeze({ ...CATALOG[id].engine }),
          limitation: CATALOG[id].limitation,
          ...(runtime.reason === undefined ? {} : { reason: runtime.reason }),
        });
      }),
    );
    const result = Object.freeze({ exitCode: 0 as const, checks });
    io.writeStdout(
      options.format === "json"
        ? `${JSON.stringify(result, null, 2)}\n`
        : renderText(result),
    );
    return result;
  } catch {
    io.writeStderr("Zedbee could not describe the configured checks.\n");
    return Object.freeze({ exitCode: 2, checks: Object.freeze([]) });
  }
}
