import type { ProjectEslintPermit } from "./trust.js";

export type ProjectEslintFailureCode =
  | "PROJECT_ESLINT_TRUST_REQUIRED"
  | "PROJECT_ESLINT_MESSAGES_TRUST_REQUIRED"
  | "PROJECT_ESLINT_INSTALL_MISSING"
  | "PROJECT_ESLINT_INSTALL_INCONSISTENT"
  | "PROJECT_ESLINT_VERSION_UNSUPPORTED"
  | "PROJECT_ESLINT_CONFIG_UNSUPPORTED"
  | "PROJECT_ESLINT_CONFIG_INVALID"
  | "PROJECT_ESLINT_LAYOUT_UNSUPPORTED"
  | "PROJECT_ESLINT_PROTOCOL_INVALID"
  | "PROJECT_ESLINT_OUTPUT_LIMIT"
  | "PROJECT_ESLINT_CANCELLED"
  | "PROJECT_ESLINT_TIMEOUT"
  | "PROJECT_ESLINT_WORKER_FAILED";

const messages: Record<ProjectEslintFailureCode, string> = {
  PROJECT_ESLINT_TRUST_REQUIRED:
    "Project ESLint requires explicit execution trust for this repository and workspace.",
  PROJECT_ESLINT_MESSAGES_TRUST_REQUIRED:
    "Full project ESLint messages require separate permission to display source-bearing messages.",
  PROJECT_ESLINT_INSTALL_MISSING:
    "A dependency required by the selected project is not installed in this checkout.",
  PROJECT_ESLINT_INSTALL_INCONSISTENT:
    "The installed dependencies do not match the selected target manifests and npm lockfile.",
  PROJECT_ESLINT_VERSION_UNSUPPORTED:
    "Project ESLint currently requires installed ESLint 9.39.5.",
  PROJECT_ESLINT_CONFIG_UNSUPPORTED:
    "Project ESLint requires a JavaScript flat configuration without processors.",
  PROJECT_ESLINT_CONFIG_INVALID:
    "The captured project ESLint configuration or rules could not run.",
  PROJECT_ESLINT_LAYOUT_UNSUPPORTED:
    "The captured repository or installation layout cannot be reproduced for project ESLint.",
  PROJECT_ESLINT_PROTOCOL_INVALID:
    "Project ESLint returned invalid diagnostics or coverage.",
  PROJECT_ESLINT_OUTPUT_LIMIT:
    "Project ESLint exceeded its response size limit.",
  PROJECT_ESLINT_CANCELLED: "Project ESLint was cancelled.",
  PROJECT_ESLINT_TIMEOUT: "Project ESLint exceeded its execution deadline.",
  PROJECT_ESLINT_WORKER_FAILED:
    "The project ESLint process failed or its cleanup could not be verified.",
};

export class ProjectEslintFailureError extends Error {
  constructor(readonly code: ProjectEslintFailureCode) {
    super(messages[code]);
    this.name = "ProjectEslintFailureError";
  }
}

export interface ProjectEslintDiagnostic {
  readonly file: string;
  readonly ruleId: string | null;
  readonly severity: 1 | 2;
  readonly message: string;
  /** Internal attribution only; never include source-derived identities in telemetry. */
  readonly comparisonIdentity?: string;
  readonly line?: number;
  readonly column?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly fatal?: boolean;
}
export interface ProjectEslintResult {
  readonly version: string;
  readonly messages: "redacted" | "full";
  readonly diagnostics: readonly ProjectEslintDiagnostic[];
  readonly checkedFiles: readonly string[];
  readonly ignoredFiles: readonly string[];
}
export interface ProjectEslintInput {
  readonly checkoutRoot: string;
  readonly snapshotRoot: string;
  readonly projectRoot: string;
  /** Repository-relative source paths, including their workspace prefix. */
  readonly files: readonly string[];
  readonly permit: ProjectEslintPermit;
  readonly signal: AbortSignal;
  readonly messages: "redacted" | "full";
  readonly allowSourceMessages: boolean;
  /** Both attribution sides use the target's selected installed environment. */
  readonly installationSnapshotRoot?: string;
}
export interface ProjectEslintInstallation {
  readonly entry: string;
  readonly version: "9.39.5";
}
export interface ProjectEslintRequest {
  readonly type: "run";
  readonly treeRoot: string;
  readonly projectRoot: string;
  readonly configFile: string;
  readonly installation: ProjectEslintInstallation;
  readonly files: readonly string[];
  readonly fullMessages: boolean;
}
