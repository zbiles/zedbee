import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { lintSource } from "@secretlint/core";
import { SECRET_LINT_CONFIG } from "../checks/secrets/config.js";
import { LockfileInventoryError } from "../checks/vulnerabilities/inventory/errors.js";
import { parseLockfileInventory } from "../checks/vulnerabilities/inventory/parse-lockfile.js";
import { createOsvClient } from "../checks/vulnerabilities/osv/client.js";
import {
  OsvAnalysisError,
  OsvUnavailableError,
} from "../checks/vulnerabilities/osv/errors.js";
import type { OsvClient } from "../checks/vulnerabilities/osv/types.js";
import { ConfigError, loadConfig } from "../config/load-config.js";
import { GitClient } from "../git/client.js";
import { buildSnapshotPair } from "../git/snapshot.js";
import { inspectRepository } from "../inspection/inspect-repository.js";
import { hasZedbeeScanCommand } from "../hooks/husky.js";
import { hasZedbeeLefthookConfig } from "../hooks/lefthook.js";
import { hasZedbeeSimpleGitHooksConfig } from "../hooks/simple-git-hooks.js";
import { hasLefthookRunCommand } from "../hooks/state.js";
import {
  isSupportedNodeVersion,
  NODE_ENGINE_RANGE,
} from "../runtime/node-support.js";

export const DOCTOR_DIAGNOSTIC_IDS = [
  "git",
  "config",
  "node",
  "snapshot-creation",
  "workspace-inspection",
  "secretlint-readiness",
  "lockfile-support",
  "osv-connectivity",
  "license-inventory",
  "hook-state",
  "online-service-disclosure",
] as const;

export type DiagnosticId = (typeof DOCTOR_DIAGNOSTIC_IDS)[number];

export interface Diagnostic {
  readonly id: string;
  readonly status: "pass" | "warning" | "fail";
  readonly message: string;
  readonly remediation?: string;
}

export interface DiagnosticContext {
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly configPath?: string;
}

export type DiagnosticProbe = (
  id: DiagnosticId,
  context: DiagnosticContext,
) => Promise<Diagnostic>;

const failure = (id: DiagnosticId): Diagnostic =>
  Object.freeze({
    id,
    status: "fail",
    message: "The diagnostic could not be completed.",
    remediation:
      "Run zedbee doctor again after correcting the reported setup issue.",
  });

export async function runDiagnostics(
  probe: DiagnosticProbe,
  context: DiagnosticContext,
): Promise<readonly Diagnostic[]> {
  const diagnostics: Diagnostic[] = [];
  for (const id of DOCTOR_DIAGNOSTIC_IDS) {
    try {
      const diagnostic = await probe(id, context);
      if (
        diagnostic.id !== id ||
        !["pass", "warning", "fail"].includes(diagnostic.status) ||
        diagnostic.message.trim() === ""
      ) {
        diagnostics.push(failure(id));
      } else {
        diagnostics.push(Object.freeze({ ...diagnostic }));
      }
    } catch {
      diagnostics.push(failure(id));
    }
  }
  return Object.freeze(diagnostics);
}

async function repositoryRoot(cwd: string): Promise<string> {
  return (await new GitClient(cwd).run(["rev-parse", "--show-toplevel"]))
    .stdout;
}

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

async function hookStateDiagnostic(root: string): Promise<Diagnostic> {
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

async function withSnapshots<T>(
  cwd: string,
  operation: (targetDir: string) => Promise<T>,
): Promise<T> {
  const root = await repositoryRoot(cwd);
  const snapshots = await buildSnapshotPair(root, new GitClient(root));
  try {
    return await operation(snapshots.targetDir);
  } finally {
    await snapshots.cleanup();
  }
}

async function inventoryIsValid(): Promise<boolean> {
  const inventoryPath = fileURLToPath(
    new URL("../../licenses/production-inventory.json", import.meta.url),
  );
  const parsed = JSON.parse(await readFile(inventoryPath, "utf8")) as {
    schemaVersion?: unknown;
    packages?: unknown;
  };
  return (
    parsed.schemaVersion === 1 &&
    Array.isArray(parsed.packages) &&
    parsed.packages.length > 0
  );
}

export interface DefaultDiagnosticDependencies {
  readonly lintSource: typeof lintSource;
  readonly nodeVersion: string;
  readonly parseLockfileInventory: typeof parseLockfileInventory;
  readonly osvClient: OsvClient;
}

const DEFAULT_PROBE_DEPENDENCIES: DefaultDiagnosticDependencies = {
  lintSource,
  nodeVersion: process.versions.node,
  parseLockfileInventory,
  osvClient: createOsvClient({ timeoutMs: 5_000, retries: 0 }),
};

function analyzableLockfiles(lockfiles: readonly string[]): readonly string[] {
  const hasTextBunLock = lockfiles.some(
    (path) => path.split("/").at(-1) === "bun.lock",
  );
  return lockfiles.filter(
    (path) => !(hasTextBunLock && path.split("/").at(-1) === "bun.lockb"),
  );
}

export function createDefaultDiagnosticProbe(
  overrides: Partial<DefaultDiagnosticDependencies> = {},
): DiagnosticProbe {
  const dependencies = { ...DEFAULT_PROBE_DEPENDENCIES, ...overrides };
  return async (id, context) => {
    switch (id) {
      case "git": {
        await new GitClient(context.cwd).run(["--version"]);
        await repositoryRoot(context.cwd);
        return {
          id,
          status: "pass",
          message: "Git and the repository are available.",
        };
      }
      case "config": {
        const root = await repositoryRoot(context.cwd);
        try {
          await loadConfig(root, context.configPath);
        } catch (error) {
          if (error instanceof ConfigError) {
            return {
              id: "config",
              status: "fail",
              message: error.message,
              remediation: `Correct ${basename(error.configPath)} and run zedbee doctor again.`,
            };
          }
          throw error;
        }
        return {
          id,
          status: "pass",
          message: "The Zedbee configuration is valid.",
        };
      }
      case "node":
        return isSupportedNodeVersion(dependencies.nodeVersion)
          ? {
              id,
              status: "pass",
              message: `Node.js satisfies ${NODE_ENGINE_RANGE}.`,
            }
          : {
              id,
              status: "fail",
              message: `Node.js does not satisfy ${NODE_ENGINE_RANGE}.`,
              remediation: `Install a Node.js version matching ${NODE_ENGINE_RANGE}.`,
            };
      case "snapshot-creation":
        await withSnapshots(context.cwd, async () => undefined);
        return {
          id,
          status: "pass",
          message: "The staged Git snapshot can be created and cleaned up.",
        };
      case "workspace-inspection": {
        const count = await withSnapshots(
          context.cwd,
          async (targetDir) =>
            (await inspectRepository(targetDir)).workspaces.length,
        );
        return {
          id,
          status: "pass",
          message: `Workspace inspection found ${count} workspace${count === 1 ? "" : "s"}.`,
        };
      }
      case "secretlint-readiness": {
        try {
          const result = await dependencies.lintSource({
            source: {
              content: "export const zedbeeSecretlintProbe = true;\n",
              filePath: "zedbee-secretlint-probe.js",
              contentType: "text",
            },
            options: {
              config: SECRET_LINT_CONFIG,
              maskSecrets: true,
              noPhysicFilePath: true,
            },
          });
          if (!Array.isArray(result.messages)) throw new TypeError();
          return {
            id,
            status: "pass",
            message:
              "The Node-native Secretlint engine and fixed recommended preset are ready.",
          };
        } catch {
          return {
            id,
            status: "fail",
            message:
              "The Node-native Secretlint engine could not analyze safe text.",
            remediation:
              "Reinstall Zedbee from a verified package and run zedbee doctor again.",
          };
        }
      }
      case "lockfile-support":
        return withSnapshots(context.cwd, async (targetDir) => {
          const inspection = await inspectRepository(targetDir);
          const lockfiles = analyzableLockfiles(inspection.lockfiles);
          if (lockfiles.length === 0) {
            return {
              id,
              status: "pass",
              message:
                "No supported JavaScript lockfile is present; vulnerability scanning has no dependency inventory.",
            };
          }
          try {
            const inventories = await Promise.all(
              lockfiles.map((path) =>
                dependencies.parseLockfileInventory(inspection, path),
              ),
            );
            const count = inventories.reduce(
              (total, inventory) => total + inventory.length,
              0,
            );
            return {
              id,
              status: "pass",
              message: `Lockfile analysis supports ${lockfiles.join(", ")} (${count} resolved dependenc${count === 1 ? "y" : "ies"}).`,
            };
          } catch (error) {
            if (error instanceof LockfileInventoryError) {
              return {
                id,
                status: "fail",
                message: error.message,
                remediation:
                  error.remediation ??
                  "Regenerate the lockfile with a supported package manager and retry.",
              };
            }
            throw error;
          }
        });
      case "osv-connectivity": {
        const root = await repositoryRoot(context.cwd);
        const config = await loadConfig(root, context.configPath);
        const policy = config.checks.vulnerabilities;
        if (policy.severity === "off") {
          return {
            id,
            status: "pass",
            message:
              "OSV connectivity is not required because vulnerability scanning is disabled.",
          };
        }
        try {
          await dependencies.osvClient.probe(new AbortController().signal);
          return {
            id,
            status: "pass",
            message:
              "OSV is reachable using Zedbee's constant synthetic connectivity probe.",
          };
        } catch (error) {
          if (error instanceof OsvUnavailableError) {
            return {
              id,
              status: policy.onUnavailable === "warn" ? "warning" : "fail",
              message: error.message,
              remediation:
                policy.onUnavailable === "warn"
                  ? "Zedbee will warn and allow commits during this outage. Set checks.vulnerabilities.onUnavailable to block for fail-closed behavior."
                  : "Restore OSV connectivity or set checks.vulnerabilities.onUnavailable to warn if commits may continue during outages.",
            };
          }
          if (error instanceof OsvAnalysisError) {
            return {
              id,
              status: "fail",
              message: error.message,
              remediation: "Update Zedbee and run zedbee doctor again.",
            };
          }
          return {
            id,
            status: "fail",
            message:
              "Zedbee could not safely complete the OSV connectivity probe.",
            remediation: "Check network access to api.osv.dev and retry.",
          };
        }
      }
      case "license-inventory":
        return (await inventoryIsValid())
          ? {
              id,
              status: "pass",
              message: "The production license inventory is present and valid.",
            }
          : {
              id,
              status: "fail",
              message: "The production license inventory is invalid.",
              remediation: "Reinstall Zedbee from a verified package.",
            };
      case "hook-state": {
        const root = await repositoryRoot(context.cwd);
        return hookStateDiagnostic(root);
      }
      case "online-service-disclosure": {
        const root = await repositoryRoot(context.cwd);
        const policy = (await loadConfig(root, context.configPath)).checks
          .vulnerabilities;
        if (policy.severity === "off") {
          return {
            id,
            status: "pass",
            message:
              "Online vulnerability scanning is disabled; Zedbee will not contact OSV.",
          };
        }
        return {
          id,
          status: "warning",
          message: `Online vulnerability checks send package names, exact versions, and ecosystem identifiers to api.osv.dev; source code and file hashes are not sent. OSV outages currently ${policy.onUnavailable === "warn" ? "warn and allow commits" : "block commits"}.`,
        };
      }
    }
  };
}

export const defaultDiagnosticProbe: DiagnosticProbe =
  createDefaultDiagnosticProbe();
