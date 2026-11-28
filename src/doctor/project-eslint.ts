import {
  escapeLabelControls,
  workspaceLabel,
} from "./workspace-installation.js";
import { SUPPORTED_PROJECT_ESLINT_VERSION } from "../checks/eslint/project/supported-version.js";
import { findProjectEslintConfig } from "../checks/eslint/project/config-file.js";
import { relative, sep } from "node:path";
import { loadConfig } from "../config/load-config.js";
import {
  assertProjectEslintConfiguration,
  resolveWorkspaceLintPolicy,
} from "../config/target-policy.js";
import { inspectRepository } from "../inspection/inspect-repository.js";
import { captureWorkingTreeRegistry } from "../inspection/working-tree-registry.js";
import { hasProjectEslintTrust } from "../checks/eslint/project/trust.js";
import { resolveProjectEslintInstallation } from "../checks/eslint/project/installation.js";
import { ProjectEslintFailureError } from "../checks/eslint/project/types.js";
import type { Diagnostic } from "./diagnostics.js";

interface ProjectEslintWorkspaceReport {
  readonly description: string;
  readonly failed: boolean;
  readonly trusted: boolean;
}

async function installationDescription(
  root: string,
  project: string,
): Promise<{ readonly text: string; readonly failed: boolean }> {
  try {
    const found = await resolveProjectEslintInstallation(root, project, root);
    return { text: `ESLint ${found.version}`, failed: false };
  } catch (error) {
    return {
      text:
        error instanceof ProjectEslintFailureError
          ? error.message
          : "Installed dependencies could not be verified.",
      failed: true,
    };
  }
}

async function describeProjectEslintWorkspace(
  root: string,
  project: string,
  invocationTrust: boolean,
): Promise<ProjectEslintWorkspaceReport> {
  const [selected, trusted, messagesTrusted, installation] = await Promise.all([
    findProjectEslintConfig(root, project, "doctor"),
    invocationTrust || hasProjectEslintTrust(root, project, "execute"),
    hasProjectEslintTrust(root, project, "messages"),
    installationDescription(root, project),
  ]);
  return {
    failed: installation.failed || !selected.supported,
    trusted,
    description: `${workspaceLabel(project)}: project engine (experimental); config ${selected.path === undefined ? "missing" : escapeLabelControls(relative(root, selected.path).split(sep).join("/"))}${selected.supported ? "" : " (unsupported or absent)"}; ${installation.text}; execution trust ${trusted ? "granted" : "not granted"}; source-bearing messages ${messagesTrusted ? "permitted" : "not granted"}`,
  };
}

/** All discovery is metadata/data only; never import native ESLint configuration. */
export async function diagnoseProjectEslint(
  root: string,
  configSelection?: string,
  invocationTrust = false,
): Promise<Diagnostic> {
  const config = await loadConfig(root, configSelection);
  const inspection = await inspectRepository(root, {
    registry: await captureWorkingTreeRegistry(root),
  });
  assertProjectEslintConfiguration(config, inspection);
  const projects = inspection.workspaces.filter(
    (workspace) =>
      resolveWorkspaceLintPolicy(config, workspace).engine === "project",
  );
  if (projects.length === 0)
    return {
      id: "project-eslint",
      status: "pass",
      message:
        "Using Zedbee's built-in ESLint. Static JSX accessibility checks use the managed rules and configured component mappings. Project configuration was not executed.",
    };
  const reports = await Promise.all(
    projects.map((workspace) =>
      describeProjectEslintWorkspace(
        root,
        workspace.relativeRoot,
        invocationTrust,
      ),
    ),
  );
  const descriptions = reports.map((report) => report.description);
  const failed = reports.some((report) => report.failed);
  const untrusted = reports.some((report) => !report.trusted);
  return {
    id: "project-eslint",
    status: failed ? "fail" : untrusted ? "warning" : "pass",
    message: `Project ESLint currently supports ESLint ${SUPPORTED_PROJECT_ESLINT_VERSION}, JavaScript flat config, local dependencies, and npm lockfile v2/v3. ${descriptions.join("; ")}. Configuration was inspected as data only and was not executed.`,
    ...(failed || untrusted
      ? {
          remediation:
            "Verify the selected workspace's supported flat configuration and matching local npm installation. Review execution trust with zedbee init --eslint-engine project --trust-project-eslint; full local messages require separate --allow-project-eslint-messages consent.",
        }
      : {}),
  };
}
