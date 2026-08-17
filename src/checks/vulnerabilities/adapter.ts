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
}

const defaults: VulnerabilitiesAdapterDependencies = {
  resolveBinary: resolveManagedBinary,
  runBinary: runManagedBinary,
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

async function collectSide(
  dependencies: VulnerabilitiesAdapterDependencies,
  binary: ManagedBinary,
  snapshotRoot: string,
  signal: AbortSignal,
) {
  const args = [
    "scan",
    "source",
    "--format=json",
    "--recursive",
    snapshotRoot,
  ];
  const result = await dependencies.runBinary(binary, args, {
    cwd: snapshotRoot,
    timeoutMs: 120_000,
    signal,
    acceptedExitCodes: [0, 1],
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
      return {
        applies: true as const,
        executionClass: "network" as const,
        requiresBaseline: true,
        targets: [TARGET],
        networkDisclosure: DISCLOSURE,
      };
    },
    async collect(context: CheckRunContext): Promise<CheckObservationSet> {
      try {
        const binary = await dependencies.resolveBinary("osv-scanner");
        const baselineObservations = await collectSide(
          dependencies,
          binary,
          context.snapshots.baselineDir,
          context.signal,
        );
        const targetObservations = await collectSide(
          dependencies,
          binary,
          context.snapshots.targetDir,
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
