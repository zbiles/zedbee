import { lstat } from "node:fs/promises";
import { join, posix } from "node:path";
import { stringify } from "yaml";
import { ZEDBEE_VERSION } from "../core/package-version.js";
import { compareCodeUnits } from "../core/compare.js";
import { captureWorkingTreeRegistry } from "../inspection/working-tree-registry.js";
import {
  parsePackageManifest,
  matchesWorkspacePattern,
  readPnpmWorkspacePatterns,
} from "../inspection/workspaces.js";
import { readContainedFile } from "../inspection/read-json.js";
import type {
  RepositoryInspection,
  PackageManager,
} from "../inspection/types.js";
import { initFileChange } from "./recommend.js";
import type { InitFileChange } from "./types.js";

export const GITHUB_WORKFLOW_PATH = ".github/workflows/zedbee.yml";
// Keep generated workflows on the reviewed Action implementation, independent of release tags.
const SCAN_ACTION_COMMIT = "f8f33d26372cbc806cd89692c664554b1c516fb7";
const CHECKOUT = "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1";
const NODE = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const BUN = "oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6";
const LOCK_MANAGERS: Readonly<
  Record<string, Exclude<PackageManager, "unknown">>
> = {
  "package-lock.json": "npm",
  "npm-shrinkwrap.json": "npm",
  "pnpm-lock.yaml": "pnpm",
  "yarn.lock": "yarn",
  "bun.lock": "bun",
  "bun.lockb": "bun",
};
type Step = Record<string, unknown>;
export class GithubWorkflowSetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GithubWorkflowSetupError";
  }
}
export interface GithubWorkflowPreparation {
  readonly status: "available" | "existing" | "unsafe" | "unsupported";
  readonly message?: string;
  readonly change?: InitFileChange;
}

async function destination(
  root: string,
  filename: string,
): Promise<"available" | "existing" | "unsafe"> {
  const parts = [".github", "workflows", filename];
  for (let index = 0; index < parts.length; index++) {
    let state;
    try {
      state = await lstat(join(root, ...parts.slice(0, index + 1)));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return "available";
      throw error;
    }
    if (
      state.isSymbolicLink() ||
      (index === 2 ? !state.isFile() : !state.isDirectory())
    )
      return "unsafe";
    if (index === 2) return "existing";
  }
  return "available";
}

function safeWorkflowValue(value: string): string {
  if (value.includes("${{") || /[\x00-\x1f\x7f]/u.test(value))
    throw new Error(
      "A project folder cannot be represented safely in the GitHub workflow.",
    );
  return value;
}
function managerVersion(value: unknown, manager: string): string | undefined {
  if (typeof value !== "string" || !value.startsWith(`${manager}@`))
    return undefined;
  const version = value.slice(manager.length + 1).split("+")[0]!;
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version))
    throw new Error(
      "The declared package manager must have an exact version for GitHub setup.",
    );
  return version;
}

async function dependencySteps(
  root: string,
  inspection: RepositoryInspection,
): Promise<Step[]> {
  const registry = await captureWorkingTreeRegistry(root);
  const manifests = new Map<string, Record<string, unknown>>();
  const workspacePatterns = new Map<string, readonly string[]>();
  for (const workspace of inspection.workspaces) {
    const parsed: unknown = JSON.parse(
      await readContainedFile(registry, workspace.manifestPath),
    );
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      throw new Error("Invalid package manifest for workflow setup.");
    manifests.set(workspace.relativeRoot, parsed as Record<string, unknown>);
    workspacePatterns.set(workspace.relativeRoot, [
      ...parsePackageManifest(parsed, workspace.manifestPath).workspacePatterns,
      ...(await readPnpmWorkspacePatterns(
        registry,
        () => undefined,
        workspace.relativeRoot,
      )),
    ]);
  }
  const installs = new Map<
    string,
    { manager: Exclude<PackageManager, "unknown">; locked: boolean }
  >();
  for (const lock of inspection.lockfiles) {
    const directory = posix.dirname(lock),
      manager = LOCK_MANAGERS[posix.basename(lock)];
    if (manager === undefined) continue;
    const previous = installs.get(directory);
    if (previous !== undefined && previous.manager !== manager)
      throw new Error(
        "Multiple package-manager lockfiles share a folder; choose one before generating a workflow.",
      );
    installs.set(directory, { manager, locked: true });
  }
  for (const workspace of inspection.workspaces) {
    if (installs.has(workspace.relativeRoot)) continue;
    if (
      [...installs.keys()].some(
        (directory) =>
          (directory === "." ||
            workspace.relativeRoot.startsWith(`${directory}/`)) &&
          matchesWorkspacePattern(
            posix.relative(directory, workspace.relativeRoot),
            workspacePatterns.get(directory) ?? [],
          ),
      )
    )
      continue;
    const manifest = manifests.get(workspace.relativeRoot)!;
    if (
      workspace.dependencyDeclarations.length === 0 &&
      (workspacePatterns.get(workspace.relativeRoot)?.length ?? 0) === 0
    )
      continue;
    const declared =
      typeof manifest.packageManager === "string"
        ? /^(npm|pnpm|yarn|bun)@/u.exec(manifest.packageManager)?.[1]
        : undefined;
    const manager = (declared ??
      (inspection.packageManager === "unknown"
        ? "npm"
        : inspection.packageManager)) as Exclude<PackageManager, "unknown">;
    installs.set(workspace.relativeRoot, { manager, locked: false });
  }
  const steps: Step[] = [];
  for (const [directory, { manager, locked }] of [...installs].sort(
    ([a], [b]) => compareCodeUnits(a, b),
  )) {
    safeWorkflowValue(directory);
    const declared = manifests.get(directory)?.packageManager;
    const version = managerVersion(declared, manager);
    if (
      manager === "yarn" &&
      version === undefined &&
      registry.resolve(posix.join(directory, "yarn.lock"))?.targetKind ===
        "file"
    ) {
      const lock = await readContainedFile(
        registry,
        posix.join(directory, "yarn.lock"),
      );
      if (/^__metadata:\s*$/mu.test(lock))
        throw new Error("Modern Yarn needs an exact packageManager version.");
    }
    const location = { "working-directory": directory };
    if (manager === "bun")
      steps.push({
        name: `Use Bun (${directory})`,
        uses: BUN,
        with: { "bun-version": version ?? "1.2.23" },
      });
    const modernYarn =
      manager === "yarn" &&
      version !== undefined &&
      Number(version.split(".")[0]) >= 2;
    const run =
      manager === "npm"
        ? locked
          ? "npm ci --ignore-scripts"
          : "npm install --ignore-scripts"
        : manager === "pnpm"
          ? `pnpm install${locked ? " --frozen-lockfile" : ""} --ignore-scripts`
          : manager === "bun"
            ? `bun install${locked ? " --frozen-lockfile" : ""} --ignore-scripts`
            : modernYarn
              ? `yarn install${locked ? " --immutable" : ""} ${Number(version!.split(".")[0]) === 2 ? "--skip-builds" : "--mode=skip-build"}`
              : `yarn install${locked ? " --frozen-lockfile" : ""} --ignore-scripts`;
    const tool =
      manager === "pnpm"
        ? `pnpm@${version ?? "10.18.0"}`
        : manager === "yarn"
          ? `${modernYarn ? "@yarnpkg/cli-dist" : "yarn"}@${version ?? "1.22.22"}`
          : manager === "npm" && version !== undefined
            ? `npm@${version}`
            : undefined;
    steps.push({
      name: `Install project dependencies (${directory})`,
      ...location,
      run:
        tool === undefined ? run : `npm exec --yes --package=${tool} -- ${run}`,
      ...(modernYarn
        ? {
            env: {
              YARN_ENABLE_SCRIPTS: "false",
              YARN_ENABLE_IMMUTABLE_INSTALLS: locked ? "true" : "false",
              YARN_NODE_LINKER: "node-modules",
            },
          }
        : {}),
    });
  }
  return steps;
}

export async function prepareGithubWorkflow(
  root: string,
  inspection: RepositoryInspection,
): Promise<GithubWorkflowPreparation> {
  for (const filename of ["zedbee.yml", "zedbee.yaml"]) {
    const status = await destination(root, filename);
    if (status === "unsafe")
      return {
        status,
        message:
          "The GitHub workflow path is unsafe. Replace symlinked or non-directory ancestors before adding the workflow.",
      };
    if (status === "existing")
      return {
        status,
        message: `Existing .github/workflows/${filename} is preserved; edit it directly to update GitHub checks.`,
      };
  }
  let steps: Step[];
  try {
    steps = await dependencySteps(root, inspection);
  } catch {
    return {
      status: "unsupported",
      message:
        "A dependency installation could not be inferred safely. Configure package-manager declarations and one lockfile per project folder, then add the GitHub workflow.",
    };
  }
  const workflow = {
    name: "Zedbee",
    on: {
      pull_request: {
        types: [
          "opened",
          "synchronize",
          "reopened",
          "ready_for_review",
          "edited",
        ],
      },
    },
    permissions: { contents: "read" },
    concurrency: {
      group:
        "zedbee-${{ github.workflow }}-${{ github.event.pull_request.number }}",
      "cancel-in-progress": true,
    },
    jobs: {
      scan: {
        name: "Zedbee",
        "runs-on": "ubuntu-latest",
        "timeout-minutes": 20,
        steps: [
          {
            name: "Check out the pull-request head",
            uses: CHECKOUT,
            with: {
              ref: "${{ github.event.pull_request.head.sha }}",
              "fetch-depth": 0,
              "persist-credentials": false,
            },
          },
          { name: "Use Node.js", uses: NODE, with: { "node-version": 24 } },
          ...steps,
          {
            name: "Scan committed pull-request changes",
            uses: `zbiles/zedbee/.github/actions/scan@${SCAN_ACTION_COMMIT}`,
            with: {
              version: ZEDBEE_VERSION,
              "base-ref": "${{ github.event.pull_request.base.sha }}",
              "report-format": "sarif",
            },
          },
        ],
      },
    },
  };
  const after =
    "# Generated by zedbee init. Review and commit this workflow to enable PR checks.\n# Dependency lifecycle scripts are disabled; customize installation steps if needed.\n# Project formatting requires an explicit trust-project-prettier input on the scan Action.\n" +
    stringify(workflow, { lineWidth: 0 });
  return {
    status: "available",
    change: initFileChange(GITHUB_WORKFLOW_PATH, null, after, 0o644),
  };
}
