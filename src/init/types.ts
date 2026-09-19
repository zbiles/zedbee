import type { CheckId, ProfileId } from "../config/schema.js";
import type { FormattingSettings } from "../checks/prettier/settings.js";
import type { ImportedFormattingOverride } from "../checks/prettier/project-types.js";
import type { Environment } from "../inspection/types.js";

export type InitFormattingChoice = "copy" | "project" | "managed" | "off";

export interface InitFormattingImport {
  readonly settings: Partial<FormattingSettings>;
  readonly overrides: readonly ImportedFormattingOverride[];
  readonly limitations: readonly string[];
}

/** Data-only detection summary; never grants or executes anything. */
export interface InitFormattingDetection {
  readonly projectRoot: string;
  readonly version?: string;
  readonly status: "available" | "missing" | "unsupported";
  readonly executableConfig: boolean;
  readonly configPaths: readonly string[];
}

export type InitHookChoice =
  | "auto"
  | "tracked"
  | "husky"
  | "lefthook"
  | "simple-git-hooks"
  | "custom"
  | "raw"
  | "none";

export type ResolvedHookChoice = Exclude<InitHookChoice, "auto" | "tracked">;
export type InitOsvUnavailable = "block" | "warn";

export const OSV_NETWORK_DISCLOSURE =
  "Online vulnerability checks send package names, exact versions, and ecosystem identifiers to api.osv.dev; source code and file hashes are not sent.";

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
  readonly hookSelection?: InitHookChoice;
  readonly hookChoices?: readonly InitHookChoice[];
  readonly hooksPathChange?: Readonly<{
    before: string | null;
    after: ".husky/_";
  }>;
  readonly hookActivation: InitHookActivation;
  readonly detectedEnvironments: readonly Environment[];
  readonly recommendedChecks: readonly CheckId[];
  readonly vulnerabilityScanningAvailable: boolean;
  readonly osvUnavailable: InitOsvUnavailable;
  readonly networkChecks: readonly InitNetworkCheck[];
  readonly limitations: readonly string[];
  readonly formatting?: InitFormattingChoice;
  readonly formattingImport?: InitFormattingImport;
  readonly formattingDetection?: readonly InitFormattingDetection[];
  readonly projectPrettierTrustRoot?: string;
  /** Set only when the executable-code disclosure was separately confirmed. */
  readonly projectPrettierTrustConfirmed?: boolean;
  readonly projectPrettierRevokeRoot?: string;
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
  readonly hookChanges?: readonly InitFileChange[] | undefined;
  readonly hooksPathChange?:
    Readonly<{ before: string | null; after: ".husky/_" }> | undefined;
  readonly hookActivation?: InitHookActivation;
  readonly formatting?: InitFormattingChoice;
  readonly formattingImport?: InitFormattingImport;
  readonly formattingDetection?: readonly InitFormattingDetection[];
  readonly projectPrettierTrustRoot?: string;
  readonly projectPrettierTrustConfirmed?: boolean;
  readonly projectPrettierRevokeRoot?: string;
}

export interface ApplyResult {
  readonly applied: boolean;
  readonly files: readonly string[];
  readonly rolledBack: boolean;
}

export interface ApplyInitDependencies {
  beforeWrite?(index: number, change: InitFileChange): Promise<void> | void;
}
