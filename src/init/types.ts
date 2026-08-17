import type { CheckId, ProfileId } from "../config/schema.js";
import type { Environment } from "../inspection/types.js";

export type InitHookChoice =
  "auto" | "husky" | "lefthook" | "simple-git-hooks" | "raw" | "none";

export type ResolvedHookChoice = Exclude<InitHookChoice, "auto">;
export type InitOsvUnavailable = "block" | "warn";

export interface InitHookActivation {
  readonly status: "active" | "pending" | "not-requested";
  readonly message: string;
  readonly remediation?: string;
}

export interface InitNetworkCheck {
  readonly id: "vulnerabilities";
  readonly usesNetwork: boolean;
  readonly disclosure: string;
  readonly onUnavailable: InitOsvUnavailable;
}

export interface InitFileChange {
  readonly relativePath: string;
  /** Internal validated destination for Git metadata outside a linked worktree. */
  readonly absolutePath?: string;
  readonly before: string | null;
  readonly after: string;
  readonly beforeHash: string | null;
  readonly afterHash: string;
  readonly diff: string;
  readonly mode: number;
}

export interface InitProposal {
  readonly repositoryRoot: string;
  readonly profile: ProfileId;
  readonly hook: ResolvedHookChoice;
  readonly hookActivation: InitHookActivation;
  readonly detectedEnvironments: readonly Environment[];
  readonly recommendedChecks: readonly CheckId[];
  readonly vulnerabilityScanningAvailable: boolean;
  readonly osvUnavailable: InitOsvUnavailable;
  readonly networkChecks: readonly InitNetworkCheck[];
  readonly limitations: readonly string[];
  readonly files: readonly InitFileChange[];
}

export interface CreateInitProposalOptions {
  readonly repositoryRoot: string;
  readonly profile: ProfileId;
  readonly hook: InitHookChoice;
  readonly checks?: readonly CheckId[];
  readonly osvUnavailable?: InitOsvUnavailable;
  readonly configBefore?: string | null;
  readonly hookChange?: InitFileChange;
  readonly hookActivation?: InitHookActivation;
}

export interface ApplyResult {
  readonly applied: boolean;
  readonly files: readonly string[];
  readonly rolledBack: boolean;
}

export interface ApplyInitDependencies {
  beforeWrite?(index: number, change: InitFileChange): Promise<void> | void;
}
