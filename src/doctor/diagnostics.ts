import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "../config/load-config.js";
import { GitClient } from "../git/client.js";
import { buildSnapshotPair } from "../git/snapshot.js";
import { inspectRepository } from "../inspection/inspect-repository.js";
import { resolveManagedBinary } from "../managed-binaries/resolve.js";
import { hasZedbeeScanCommand } from "../hooks/husky.js";
import { hasZedbeeLefthookConfig } from "../hooks/lefthook.js";
import { hasZedbeeSimpleGitHooksConfig } from "../hooks/simple-git-hooks.js";
import { hasLefthookRunCommand } from "../hooks/state.js";

export const DOCTOR_DIAGNOSTIC_IDS = [
  "git",
  "config",
  "node",
  "snapshot-creation",
  "workspace-inspection",
  "managed-engines",
  "managed-engine-checksums",
  "license-inventory",
  "hook-state",
  "offline-database",
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

function nodeSupported(version: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/u.exec(version);
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return (
    major > 22 || (major === 22 && (minor > 13 || (minor === 13 && patch >= 0)))
  );
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

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path !== ".." &&
    !isAbsolute(path) &&
    !path.startsWith("../") &&
    !path.startsWith("..\\")
  );
}

async function defaultProbe(
  id: DiagnosticId,
  context: DiagnosticContext,
): Promise<Diagnostic> {
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
      await loadConfig(root, context.configPath);
      return {
        id,
        status: "pass",
        message: "The Zedbee configuration is valid.",
      };
    }
    case "node":
      return nodeSupported(process.versions.node)
        ? {
            id,
            status: "pass",
            message: "Node.js satisfies the 22.13.0 minimum.",
          }
        : {
            id,
            status: "fail",
            message: "Node.js is below the 22.13.0 minimum.",
            remediation: "Install Node.js 22.13.0 or newer.",
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
    case "managed-engines": {
      const engines = await Promise.all([
        resolveManagedBinary("gitleaks"),
        resolveManagedBinary("osv-scanner"),
      ]);
      return {
        id,
        status: "pass",
        message: `Managed engines are available (Gitleaks ${engines[0].version}, OSV-Scanner ${engines[1].version}).`,
      };
    }
    case "managed-engine-checksums":
      await Promise.all([
        resolveManagedBinary("gitleaks"),
        resolveManagedBinary("osv-scanner"),
      ]);
      return {
        id,
        status: "pass",
        message: "Managed executable and configuration checksums are valid.",
      };
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
    case "offline-database": {
      const configured = context.environment.ZEDBEE_OSV_DATABASE;
      if (configured === undefined || configured.trim() === "") {
        return {
          id,
          status: "warning",
          message: "No offline OSV database is configured.",
          remediation:
            "Set ZEDBEE_OSV_DATABASE before selecting offline vulnerability checks.",
        };
      }
      const rootMetadata = await lstat(configured);
      const resolved = await realpath(configured);
      if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
        throw new Error("unsupported database entry");
      }
      const databasePath = join(resolved, "osv-scanner", "npm", "all.zip");
      const databaseMetadata = await lstat(databasePath);
      const database = await realpath(databasePath);
      if (
        databaseMetadata.isSymbolicLink() ||
        !databaseMetadata.isFile() ||
        !contained(resolved, database)
      ) {
        throw new Error("unsupported database entry");
      }
      return {
        id,
        status: "pass",
        message: "The configured offline OSV database is accessible.",
      };
    }
    case "online-service-disclosure":
      return {
        id,
        status: "warning",
        message:
          "Online vulnerability checks disclose package names, versions, ecosystems, and supported file hashes to OSV or deps.dev; source code is not sent.",
      };
  }
}

export const defaultDiagnosticProbe: DiagnosticProbe = defaultProbe;
