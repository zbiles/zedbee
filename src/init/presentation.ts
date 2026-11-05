import { ImportCaptureError } from "../checks/prettier/project-import-capture.js";
import { ProjectWorkspaceLayoutError } from "../checks/prettier/project-workspace.js";
import { ProjectPrettierFailureError } from "../checks/prettier/project-error.js";
import { ExecutableImportStaleError } from "./import-provenance.js";
import { ProjectPrettierTrustRequiredError } from "./formatter-setup.js";
import { HookInstallationError } from "../hooks/command.js";
import { RepositoryInspectionError } from "../inspection/types.js";
import { GithubWorkflowSetupError } from "./github-workflow.js";
import type { InitProposal } from "./types.js";

export function publicProposal(proposal: InitProposal) {
  return {
    profile: proposal.profile,
    workflow: proposal.workflow ?? "none",
    workflowAvailable: proposal.workflowAvailable ?? false,
    ...(proposal.workflowMessage === undefined
      ? {}
      : { workflowMessage: proposal.workflowMessage }),
    hook: proposal.hook,
    hookActivation: proposal.hookActivation,
    ...(proposal.hooksPathChange === undefined
      ? {}
      : { hooksPathChange: proposal.hooksPathChange }),
    detectedEnvironments: proposal.detectedEnvironments,
    recommendedChecks: proposal.recommendedChecks,
    formatting: proposal.formatting ?? "managed",
    formattingScope: proposal.formattingScope ?? "repository",
    formattingScopeRoots: proposal.formattingScopeRoots ?? [],
    ...(proposal.formattingDetection === undefined
      ? {}
      : { formattingDetection: proposal.formattingDetection }),
    ...(proposal.formattingImport === undefined
      ? {}
      : {
          formattingImport: {
            settings: proposal.formattingImport.settings,
            overrides: proposal.formattingImport.overrides,
            limitations: proposal.formattingImport.limitations,
          },
        }),
    vulnerabilityScanningAvailable: proposal.vulnerabilityScanningAvailable,
    osvUnavailable: proposal.osvUnavailable,
    networkChecks: proposal.networkChecks,
    limitations: proposal.limitations,
    files: proposal.files.map(
      ({ relativePath, beforeHash, afterHash, diff, mode }) => ({
        relativePath,
        beforeHash,
        afterHash,
        diff,
        mode,
      }),
    ),
  };
}

export function renderText(proposal: InitProposal, applied: boolean): string {
  const lines = [
    applied
      ? "Zedbee initialization applied."
      : "Zedbee initialization preview.",
    `Profile: ${proposal.profile}`,
    `Hook: ${proposal.hook}`,
    `GitHub workflow: ${proposal.workflow === "github" ? "requested" : "not requested"}`,
    ...(proposal.workflowMessage === undefined
      ? []
      : [proposal.workflowMessage]),
    `Hook activation: ${proposal.hookActivation.status} — ${proposal.hookActivation.message}`,
    `Detected: ${proposal.detectedEnvironments.join(", ") || "none"}`,
    `Recommended checks: ${proposal.recommendedChecks.join(", ") || "none"}`,
    `Formatting: ${proposal.formatting ?? "managed"}`,
    `Formatting scope: ${proposal.formattingScope === "projects" ? proposal.formattingScopeRoots?.join(", ") || "repository" : "whole repository"}`,
    ...(proposal.formattingDetection ?? []).map(
      (entry) =>
        `Prettier setup: ${
          entry.projectRoot === "." ? "repository root" : entry.projectRoot
        } — ${entry.status}${
          entry.version === undefined ? "" : ` (Prettier ${entry.version})`
        }${entry.executableConfig ? "; executable configuration" : ""}`,
    ),
    ...(proposal.formattingDetection !== undefined &&
    proposal.formattingDetection.length === 0
      ? ["Prettier setup: none detected; Zedbee keeps its managed formatter."]
      : []),
    ...(proposal.vulnerabilityScanningAvailable
      ? [`OSV unavailable: ${proposal.osvUnavailable}`]
      : []),
  ];
  for (const network of proposal.networkChecks) {
    lines.push(`Network: ${network.disclosure}`);
  }
  if (proposal.hookActivation.remediation !== undefined) {
    lines.push(
      `Hook activation required: ${proposal.hookActivation.remediation}`,
    );
  }
  for (const file of proposal.files) lines.push("", file.diff);
  if (proposal.hooksPathChange !== undefined)
    lines.push(
      `Git configuration: core.hooksPath → ${proposal.hooksPathChange.after}`,
    );
  if (applied)
    lines.push(
      "",
      "Stage .zedbeerc.jsonc and the other setup files before checking or committing; commit checks use staged configuration.",
    );
  if (!applied) lines.push("", "No files were written without confirmation.");
  return `${lines.join("\n")}\n`;
}

export function renderInitFailure(error: unknown): string {
  const lines = ["Zedbee could not initialize this repository safely."];
  if (
    error instanceof ImportCaptureError ||
    error instanceof ProjectWorkspaceLayoutError
  ) {
    lines.push(
      "Reason: One-time Prettier import is unavailable for these configuration inputs or installed dependency layout.",
      "Remediation: Use managed formatting settings or project formatting, or reduce the captured inputs and retry.",
    );
  } else if (error instanceof ExecutableImportStaleError) {
    lines.push(`Reason: ${error.message}`);
  } else if (
    error instanceof ProjectPrettierFailureError &&
    error.code === "PROJECT_PRETTIER_CONFIG_INVALID"
  ) {
    lines.push(
      "Reason: The project configuration could not be evaluated from captured inputs; one-time import is unavailable.",
      "Remediation: Check relative shared configuration paths and installed dependencies, then retry.",
    );
  } else if (error instanceof GithubWorkflowSetupError) {
    lines.push(`Reason: ${error.message}`);
  } else if (error instanceof HookInstallationError) {
    lines.push(error.message);
  } else if (
    error instanceof RepositoryInspectionError &&
    error.code === "UNSAFE_SNAPSHOT_PATH"
  ) {
    lines.push(
      "Reason: Repository inspection found a symbolic link that leaves the repository.",
      "Remediation: Remove the external link or move it into a directory Zedbee ignores.",
    );
  } else if (error instanceof ProjectPrettierTrustRequiredError) {
    lines.push(`Reason: ${error.message}`);
    lines.push(
      "Remediation: Re-run zedbee init with --trust-project-prettier, or run interactively to review the execution disclosure.",
    );
  } else if (
    error instanceof Error &&
    error.message.includes("unresolved limitations")
  ) {
    lines.push(`Reason: ${error.message}`);
    lines.push(
      "Remediation: Run zedbee init interactively to review and accept the settings-copy limitations.",
    );
  }
  return `${lines.join("\n")}\n`;
}

export function renderInteractiveResult(
  confirmed: boolean,
  proposal: InitProposal,
): string {
  if (!confirmed) return "Zedbee initialization cancelled\n";
  const lines = [
    "Zedbee initialized successfully",
    "Stage .zedbeerc.jsonc and the other setup files before checking or committing; commit checks use staged configuration.",
  ];
  if (proposal.hookActivation.remediation !== undefined) {
    lines.push(`Next step: ${proposal.hookActivation.remediation}`);
  }
  return `${lines.join("\n")}\n`;
}
