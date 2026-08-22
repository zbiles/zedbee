import type {
  CheckObservationSet,
  CheckRunContext,
  InspectionContext,
  ObservationCheckAdapter,
} from "../adapter.js";
import { CheckIncompleteError } from "../incomplete-error.js";
import type { RepositoryInspection } from "../../inspection/types.js";
import { parseLockfileInventory } from "./inventory/parse-lockfile.js";
import {
  LockfileInventoryError,
  type LockfileInventoryErrorCode,
} from "./inventory/errors.js";
import type { DependencyInventory } from "./inventory/types.js";
import { normalizeOsvInventory } from "./normalize.js";
import { createOsvClient, osvQueryKey } from "./osv/client.js";
import { OsvAnalysisError, OsvUnavailableError } from "./osv/errors.js";
import type { OsvClient, OsvPackageQuery } from "./osv/types.js";
import type { ResolvedCheckPolicies } from "../../config/schema.js";

const TARGET = Object.freeze({
  id: ".",
  kind: "repository" as const,
  relativeRoot: ".",
});
const DISCLOSURE = Object.freeze({
  services: Object.freeze(["api.osv.dev"]),
  metadata: Object.freeze([
    "package names",
    "exact versions",
    "ecosystem identifiers",
  ]),
});

export interface VulnerabilitiesAdapterDependencies {
  readonly parseInventory: typeof parseLockfileInventory;
  readonly client: OsvClient;
}

const defaults: VulnerabilitiesAdapterDependencies = {
  parseInventory: parseLockfileInventory,
  client: createOsvClient(),
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

function analyzableLockfiles(
  inspection: RepositoryInspection,
): readonly string[] {
  const hasTextBunLock = inspection.lockfiles.some(
    (path) => path.split("/").at(-1) === "bun.lock",
  );
  return inspection.lockfiles.filter(
    (path) => !(hasTextBunLock && path.split("/").at(-1) === "bun.lockb"),
  );
}

async function inventoryFor(
  inspection: RepositoryInspection,
  parseInventory: typeof parseLockfileInventory,
): Promise<DependencyInventory> {
  const inventories = await Promise.all(
    analyzableLockfiles(inspection).map((path) =>
      parseInventory(inspection, path),
    ),
  );
  return Object.freeze(inventories.flat());
}

function queryUnion(
  baseline: DependencyInventory,
  target: DependencyInventory,
): readonly OsvPackageQuery[] {
  const unique = new Map<string, OsvPackageQuery>();
  for (const dependency of [...baseline, ...target]) {
    const query = Object.freeze({
      name: dependency.name,
      version: dependency.version,
      ecosystem: dependency.ecosystem,
    });
    const key = osvQueryKey(query);
    if (!unique.has(key)) unique.set(key, query);
  }
  return Object.freeze([...unique.values()]);
}

function inventoryRemediation(code: LockfileInventoryErrorCode): string {
  if (code === "LOCKFILE_VERSION_UNSUPPORTED") {
    return "Update Zedbee or regenerate the lockfile with a supported package-manager version.";
  }
  return "Regenerate the lockfile with the repository's package manager, stage it, and retry.";
}

function safeIncomplete(
  error: unknown,
  onUnavailable: "block" | "warn",
): CheckIncompleteError {
  if (error instanceof OsvUnavailableError) {
    return new CheckIncompleteError({
      code: error.code,
      message: error.message,
      remediation:
        "Retry the scan. To allow commits during an OSV outage, set checks.vulnerabilities.onUnavailable to warn.",
      disposition: onUnavailable,
    });
  }
  if (error instanceof LockfileInventoryError) {
    return new CheckIncompleteError({
      code: error.code,
      message: error.message,
      remediation: error.remediation ?? inventoryRemediation(error.code),
    });
  }
  if (error instanceof OsvAnalysisError) {
    return new CheckIncompleteError({
      code: error.code,
      message: error.message,
      remediation:
        "Retry the scan. If the response remains invalid, update Zedbee and run zedbee doctor.",
    });
  }
  return new CheckIncompleteError({
    code: "VULNERABILITY_ANALYSIS_FAILED",
    message: "Vulnerability analysis could not be completed safely.",
    remediation: "Run zedbee doctor, update Zedbee, and retry the scan.",
  });
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
        const [baselineInventory, targetInventory] = await Promise.all([
          inventoryFor(context.baselineInspection, dependencies.parseInventory),
          inventoryFor(context.targetInspection, dependencies.parseInventory),
        ]);
        const advisories = await dependencies.client.query(
          queryUnion(baselineInventory, targetInventory),
          context.signal,
        );
        return {
          checkId: "vulnerabilities",
          target: context.target,
          baselineObservations: normalizeOsvInventory(
            baselineInventory,
            advisories,
          ),
          targetObservations: normalizeOsvInventory(
            targetInventory,
            advisories,
          ),
          projectDelta: hasDependencyStateDelta(context),
        };
      } catch (error) {
        const policy =
          context.policy as ResolvedCheckPolicies["vulnerabilities"];
        throw safeIncomplete(error, policy.onUnavailable ?? "block");
      }
    },
  });
}

export const vulnerabilitiesAdapter = createVulnerabilitiesAdapter();
