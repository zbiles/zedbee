import { lstat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
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

async function configPath(
  root: string,
  projectRoot: string,
): Promise<{ path?: string; supported: boolean }> {
  let directory = resolve(root, projectRoot);
  while (directory === root || directory.startsWith(`${root}${sep}`)) {
    for (const name of [
      "eslint.config.js",
      "eslint.config.mjs",
      "eslint.config.cjs",
      "eslint.config.ts",
      "eslint.config.mts",
      "eslint.config.cts",
      ".eslintrc",
      ".eslintrc.json",
      ".eslintrc.js",
      ".eslintrc.cjs",
      ".eslintrc.yml",
      ".eslintrc.yaml",
    ]) {
      const path = join(directory, name);
      const state = await lstat(path).catch(() => undefined);
      if (state === undefined) continue;
      return {
        path: relative(root, path).split(sep).join("/"),
        supported:
          state.isFile() &&
          [
            "eslint.config.js",
            "eslint.config.mjs",
            "eslint.config.cjs",
          ].includes(name),
      };
    }
    if (directory === root) break;
    directory = dirname(directory);
  }
  return { supported: false };
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
  const descriptions: string[] = [];
  let failed = false,
    untrusted = false;
  for (const workspace of projects) {
    const project = workspace.relativeRoot;
    const selected = await configPath(root, project);
    const trusted =
      invocationTrust ||
      (await hasProjectEslintTrust(root, project, "execute"));
    const messagesTrusted = await hasProjectEslintTrust(
      root,
      project,
      "messages",
    );
    let installation: string;
    try {
      const found = await resolveProjectEslintInstallation(root, project, root);
      installation = `ESLint ${found.version}`;
    } catch (error) {
      failed = true;
      installation =
        error instanceof ProjectEslintFailureError
          ? error.message
          : "Installed dependencies could not be verified.";
    }
    if (!selected.supported) failed = true;
    if (!trusted) untrusted = true;
    descriptions.push(
      `${project === "." ? "root" : project}: project engine (experimental); config ${selected.path ?? "missing"}${selected.supported ? "" : " (unsupported or absent)"}; ${installation}; execution trust ${trusted ? "granted" : "not granted"}; source-bearing messages ${messagesTrusted ? "permitted" : "not granted"}`,
    );
  }
  return {
    id: "project-eslint",
    status: failed ? "fail" : untrusted ? "warning" : "pass",
    message: `Project ESLint currently supports ESLint 9.39.5, JavaScript flat config, local dependencies, and npm lockfile v2/v3. ${descriptions.join("; ")}. Configuration was inspected as data only and was not executed.`,
    ...(failed || untrusted
      ? {
          remediation:
            "Verify the selected workspace's supported flat configuration and matching local npm installation. Review execution trust with zedbee init --eslint-engine project --trust-project-eslint; full local messages require separate --allow-project-eslint-messages consent.",
        }
      : {}),
  };
}
