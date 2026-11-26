import { lstat, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { GitClient } from "../git/client.js";
import { hasZedbeeScanCommand } from "../hooks/husky.js";
import { hasZedbeeLefthookConfig } from "../hooks/lefthook.js";
import { hasZedbeeSimpleGitHooksConfig } from "../hooks/simple-git-hooks.js";
import { hasLefthookRunCommand } from "../hooks/state.js";
import { inspectHookMaintenance } from "../hooks/update-notice.js";
import type { Diagnostic } from "./diagnostics.js";

async function regularFileContents(path: string): Promise<string | undefined> {
  try {
    const state = await lstat(path);
    if (state.isSymbolicLink() || !state.isFile()) return undefined;
    return readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function hookMaintenanceDiagnostic(
  root: string,
): Promise<Diagnostic | undefined> {
  const { hookUpdate, sharedHuskyPreCommit } =
    await inspectHookMaintenance(root);
  if (hookUpdate !== undefined) {
    return {
      id: "hook-state",
      status: "warning",
      message: hookUpdate.message,
      remediation: hookUpdate.remediation,
    };
  }
  if (sharedHuskyPreCommit !== undefined) {
    return sharedHuskyPreCommit
      ? {
          id: "hook-state",
          status: "pass",
          message: "The shared Husky pre-commit hook invokes Zedbee.",
        }
      : {
          id: "hook-state",
          status: "warning",
          message: "The shared Husky pre-commit hook does not invoke Zedbee.",
          remediation:
            "Run zedbee init in the main checkout to add Zedbee to the shared hook.",
        };
  }
  return undefined;
}

export async function hookStateDiagnostic(root: string): Promise<Diagnostic> {
  const maintenance = await hookMaintenanceDiagnostic(root);
  if (maintenance !== undefined) return maintenance;
  const hookOutput = await new GitClient(root).run([
    "rev-parse",
    "--git-path",
    "hooks/pre-commit",
  ]);
  const hookPath = isAbsolute(hookOutput.stdout)
    ? resolve(hookOutput.stdout)
    : resolve(root, hookOutput.stdout);
  const [installedHook, huskyHook, lefthookYaml, lefthookYml, manifest] =
    await Promise.all([
      regularFileContents(hookPath),
      regularFileContents(join(root, ".husky/pre-commit")),
      regularFileContents(join(root, "lefthook.yaml")),
      regularFileContents(join(root, "lefthook.yml")),
      regularFileContents(join(root, "package.json")),
    ]);
  if (
    (installedHook !== undefined && hasZedbeeScanCommand(installedHook)) ||
    (huskyHook !== undefined && hasZedbeeScanCommand(huskyHook))
  ) {
    return {
      id: "hook-state",
      status: "pass",
      message: "The active pre-commit path invokes Zedbee.",
    };
  }
  const lefthookConfigured = [lefthookYaml, lefthookYml].some(
    (source) => source !== undefined && hasZedbeeLefthookConfig(source),
  );
  if (
    lefthookConfigured &&
    installedHook !== undefined &&
    hasLefthookRunCommand(installedHook)
  ) {
    return {
      id: "hook-state",
      status: "pass",
      message:
        "The active Lefthook pre-commit path invokes the configured Zedbee command.",
    };
  }
  const simpleGitHooksConfigured =
    manifest !== undefined && hasZedbeeSimpleGitHooksConfig(manifest);
  if (lefthookConfigured) {
    return {
      id: "hook-state",
      status: "warning",
      message: "Zedbee is configured but is not active in Git (Lefthook).",
      remediation:
        "After reviewing the project tooling, run lefthook install to activate the configured hook.",
    };
  }
  if (simpleGitHooksConfigured) {
    return {
      id: "hook-state",
      status: "warning",
      message:
        "Zedbee is configured but is not active in Git (simple-git-hooks).",
      remediation:
        "After reviewing the project tooling, run npx --no-install simple-git-hooks to activate the configured hook.",
    };
  }
  if (installedHook !== undefined || huskyHook !== undefined) {
    return {
      id: "hook-state",
      status: "warning",
      message: "A pre-commit hook exists but does not invoke Zedbee.",
      remediation: "Run zedbee init to add Zedbee to the existing hook.",
    };
  }
  return {
    id: "hook-state",
    status: "warning",
    message: "No active Zedbee pre-commit hook is installed.",
    remediation: "Run zedbee init to configure a hook.",
  };
}
