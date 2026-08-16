import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative } from "node:path";
import type {
  CheckObservationSet,
  CheckRunContext,
  InspectionContext,
  ObservationCheckAdapter,
} from "../adapter.js";
import { resolveManagedBinary } from "../../managed-binaries/resolve.js";
import { runManagedBinary } from "../../managed-binaries/run.js";
import type {
  ManagedBinary,
  ManagedRunOptions,
  ManagedRunResult,
} from "../../managed-binaries/types.js";
import { normalizeOsvReport } from "./normalize.js";

const TARGET = Object.freeze({
  id: ".",
  kind: "repository" as const,
  relativeRoot: ".",
});
const DISCLOSURE = Object.freeze({
  services: Object.freeze(["api.osv.dev", "api.deps.dev"]),
  metadata: Object.freeze([
    "package names",
    "versions",
    "ecosystems",
    "supported file hashes",
  ]),
});

interface VulnerabilitiesAdapterDependencies {
  readonly resolveBinary: typeof resolveManagedBinary;
  readonly runBinary: (
    binary: ManagedBinary,
    args: readonly string[],
    options: ManagedRunOptions,
  ) => Promise<ManagedRunResult>;
  readonly offlineDatabasePath: () => string | undefined;
}

const defaults: VulnerabilitiesAdapterDependencies = {
  resolveBinary: resolveManagedBinary,
  runBinary: runManagedBinary,
  offlineDatabasePath: () => process.env.ZEDBEE_OSV_DATABASE,
};

function dependencyStatePaths(context: InspectionContext): ReadonlySet<string> {
  return new Set([
    ...context.baselineInspection.lockfiles,
    ...context.targetInspection.lockfiles,
  ]);
}

function hasDependencyStateDelta(context: InspectionContext): boolean {
  const dependencyPaths = dependencyStatePaths(context);
  return [...context.changeSet.files.values()].some(({ path }) =>
    dependencyPaths.has(path),
  );
}

function contained(root: string, path: string): boolean {
  const candidate = relative(root, path);
  return (
    candidate !== ".." &&
    !isAbsolute(candidate) &&
    !candidate.startsWith("../") &&
    !candidate.startsWith("..\\")
  );
}

async function verifiedOfflineDatabase(
  configured: string | undefined,
): Promise<string> {
  if (configured === undefined || configured.trim().length === 0) {
    throw new Error("Vulnerability analysis failed.");
  }
  const rootMetadata = await lstat(configured);
  const root = await realpath(configured);
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Vulnerability analysis failed.");
  }
  const npmDatabase = join(root, "osv-scanner", "npm", "all.zip");
  const databaseMetadata = await lstat(npmDatabase);
  const database = await realpath(npmDatabase);
  if (
    databaseMetadata.isSymbolicLink() ||
    !databaseMetadata.isFile() ||
    !contained(root, database)
  ) {
    throw new Error("Vulnerability analysis failed.");
  }
  return root;
}

async function collectSide(
  dependencies: VulnerabilitiesAdapterDependencies,
  binary: ManagedBinary,
  snapshotRoot: string,
  mode: "online" | "offline",
  database: string | undefined,
  signal: AbortSignal,
) {
  const args = [
    "scan",
    "source",
    ...(mode === "offline" ? ["--offline", "--offline-vulnerabilities"] : []),
    "--format=json",
    "--recursive",
    snapshotRoot,
  ];
  const result = await dependencies.runBinary(binary, args, {
    cwd: snapshotRoot,
    timeoutMs: 120_000,
    signal,
    acceptedExitCodes: [0, 1],
    ...(database === undefined
      ? {}
      : {
          environment: {
            OSV_SCANNER_LOCAL_DB_CACHE_DIRECTORY: database,
          },
        }),
  });
  let rawReport = result.stdout;
  const normalized = normalizeOsvReport(rawReport, snapshotRoot);
  rawReport = "";
  return normalized;
}

export function createVulnerabilitiesAdapter(
  dependencies: VulnerabilitiesAdapterDependencies = defaults,
): ObservationCheckAdapter {
  return Object.freeze({
    id: "vulnerabilities",
    output: "observations" as const,
    async inspect(context: InspectionContext) {
      if (
        context.config.checks.vulnerabilities.when !== "always" &&
        !hasDependencyStateDelta(context)
      ) {
        return {
          applies: false as const,
          reason: "No staged dependency state changes",
        };
      }
      const online =
        (context.config.checks.vulnerabilities.network ?? "online") ===
        "online";
      return {
        applies: true as const,
        executionClass: online
          ? ("network" as const)
          : ("project-analysis" as const),
        requiresBaseline: true,
        targets: [TARGET],
        ...(online ? { networkDisclosure: DISCLOSURE } : {}),
      };
    },
    async collect(context: CheckRunContext): Promise<CheckObservationSet> {
      try {
        const mode = context.policy.network ?? "online";
        const database =
          mode === "offline"
            ? await verifiedOfflineDatabase(dependencies.offlineDatabasePath())
            : undefined;
        const binary = await dependencies.resolveBinary("osv-scanner");
        const baselineObservations = await collectSide(
          dependencies,
          binary,
          context.snapshots.baselineDir,
          mode,
          database,
          context.signal,
        );
        const targetObservations = await collectSide(
          dependencies,
          binary,
          context.snapshots.targetDir,
          mode,
          database,
          context.signal,
        );
        return {
          checkId: "vulnerabilities",
          target: context.target,
          baselineObservations,
          targetObservations,
          projectDelta: hasDependencyStateDelta(context),
        };
      } catch {
        throw new Error("Vulnerability analysis failed.");
      }
    },
  });
}

export const vulnerabilitiesAdapter = createVulnerabilitiesAdapter();
