import type { CheckId, ProfileId } from "../config/schema.js";
import type { DetectedHookIntegration } from "../hooks/detect.js";
import type { FormattingSetup } from "./formatter-setup.js";
import type {
  CreateInitProposalOptions,
  EvaluatedExecutableImports,
  InitFormattingChoice,
  InitFormattingScope,
  InitHookChoice,
  InitOsvUnavailable,
  InitWorkflowChoice,
} from "./types.js";

/** The same selection contract is used by CLI flags and the interactive prompt. */
export interface InitSelection {
  readonly profile: ProfileId;
  readonly checks?: readonly CheckId[] | undefined;
  readonly osvUnavailable?: InitOsvUnavailable | undefined;
  readonly hook?: InitHookChoice | undefined;
  readonly formatting?: InitFormattingChoice | undefined;
  readonly projectTrust?: boolean | undefined;
  readonly evaluatedImport?: EvaluatedExecutableImports | undefined;
  readonly scope?: InitFormattingScope | undefined;
  readonly workflow?: InitWorkflowChoice | undefined;
}

export interface InitSelectionContext {
  readonly base: Omit<
    CreateInitProposalOptions,
    | "profile"
    | "hook"
    | "hookChange"
    | "hookChanges"
    | "hookActivation"
    | "hooksPathChange"
  >;
  readonly defaults: InitSelection & {
    readonly hook: InitHookChoice;
    readonly scope: InitFormattingScope;
  };
  readonly integrations: ReadonlyMap<InitHookChoice, DetectedHookIntegration>;
  readonly formatting: Pick<
    FormattingSetup,
    "imported" | "detection" | "projectRoots"
  >;
  readonly invocationTrust: boolean;
}

/** Data-only policy: no discovery, evaluation, persistence or prompt behavior. */
export function buildInitSelectionOptions(
  context: InitSelectionContext,
  selection: InitSelection,
): CreateInitProposalOptions {
  const hook = selection.hook ?? context.defaults.hook;
  const integration = context.integrations.get(hook);
  if (integration === undefined) throw new Error("Invalid hook selection.");
  const formatting = selection.formatting ?? context.defaults.formatting;
  const evaluated =
    selection.evaluatedImport ?? context.defaults.evaluatedImport;
  const roots = context.formatting.projectRoots;
  const trustGranted =
    formatting === "project" &&
    (context.invocationTrust ||
      (selection.projectTrust ?? context.defaults.projectTrust) === true);
  const checks = selection.checks;
  const osvUnavailable =
    selection.osvUnavailable ?? context.defaults.osvUnavailable;
  return {
    ...context.base,
    profile: selection.profile,
    ...(checks === undefined ? {} : { checks }),
    ...(osvUnavailable === undefined ? {} : { osvUnavailable }),
    hook: integration.hook,
    hookActivation: integration.activation,
    hookChanges: integration.changes,
    hooksPathChange: integration.hooksPathChange,
    ...(integration.change === undefined
      ? {}
      : { hookChange: integration.change }),
    workflow: selection.workflow ?? context.defaults.workflow ?? "none",
    formattingScope: selection.scope ?? context.defaults.scope,
    formattingScopeRoots: roots,
    formattingDetection: context.formatting.detection,
    ...(formatting === undefined ? {} : { formatting }),
    ...(formatting === "copy"
      ? {
          formattingImport: evaluated?.imported ?? context.formatting.imported,
          ...(evaluated === undefined
            ? {}
            : { executableEvaluatedConfigs: evaluated.evaluatedConfigs }),
        }
      : {}),
    ...(formatting === "project"
      ? {
          formattingProjectRoots: roots.filter((root) => root !== "."),
          formattingRootProject: roots.includes("."),
        }
      : {}),
    ...(trustGranted
      ? {
          projectPrettierTrustRoots: roots,
          projectPrettierTrustConfirmed: true,
        }
      : {}),
    ...((formatting === "managed" || formatting === "off") && roots.length > 0
      ? {
          projectPrettierRevokeRoots: roots,
        }
      : {}),
  };
}
