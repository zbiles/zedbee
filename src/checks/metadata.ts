import type { CheckId } from "../config/schema.js";

export type ObservationInputCoverage =
  "snapshot-only" | "installed-dependencies" | "disabled";

export interface ManagedCheckMetadata {
  readonly id: CheckId;
  /** Inputs outside this declaration make observation caching ineligible. */
  readonly observationInputs: ObservationInputCoverage;
}

function metadata<
  const TId extends CheckId,
  const TInputs extends ObservationInputCoverage,
>(
  id: TId,
  observationInputs: TInputs,
): Readonly<{ id: TId; observationInputs: TInputs }> {
  return Object.freeze({ id, observationInputs });
}

/**
 * Engine-free check metadata. Runner/controller code may import this module
 * without loading analyzer packages.
 */
export const CHECK_METADATA = Object.freeze({
  formatting: metadata("formatting", "disabled"),
  lint: metadata("lint", "installed-dependencies"),
  types: metadata("types", "installed-dependencies"),
  cyclomaticComplexity: metadata("cyclomaticComplexity", "snapshot-only"),
  readabilityComplexity: metadata("readabilityComplexity", "snapshot-only"),
  structuralSecurity: metadata("structuralSecurity", "snapshot-only"),
  secrets: metadata("secrets", "disabled"),
  duplication: metadata("duplication", "snapshot-only"),
  dependencyArchitecture: metadata("dependencyArchitecture", "snapshot-only"),
  deadCode: metadata("deadCode", "installed-dependencies"),
  reactCorrectness: metadata("reactCorrectness", "snapshot-only"),
  reactAccessibility: metadata("reactAccessibility", "snapshot-only"),
  vulnerabilities: metadata("vulnerabilities", "disabled"),
}) satisfies Readonly<Record<CheckId, ManagedCheckMetadata>>;

export type CacheableObservationCheckId =
  | {
      [
        K in CheckId
      ]: (typeof CHECK_METADATA)[K]["observationInputs"] extends "snapshot-only"
        ? K
        : never;
    }[CheckId]
  | "lint"
  | "types"
  | "deadCode";

export function managedCheckMetadata(
  checkId: string,
): ManagedCheckMetadata | undefined {
  if (!Object.hasOwn(CHECK_METADATA, checkId)) return undefined;
  return CHECK_METADATA[checkId as CheckId];
}

export function isCacheableObservationCheck(
  checkId: string,
): checkId is CacheableObservationCheckId {
  return (
    checkId === "lint" ||
    checkId === "types" ||
    checkId === "deadCode" ||
    managedCheckMetadata(checkId)?.observationInputs === "snapshot-only"
  );
}
