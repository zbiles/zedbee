import { CHECK_IDS, type CheckId } from "../config/schema.js";
import type { FilePolicyResolver } from "../config/file-policy.js";
import {
  inputContractFor,
  type ArtifactKind,
  type CheckInputContract,
} from "../checks/input-contract.js";
import { compareCodeUnits } from "../core/compare.js";
import type { UnsupportedIndexEntry } from "../git/snapshot.js";
import type { ScanFailureInput } from "./incomplete-report.js";

export interface UnsupportedInputDecision {
  readonly path: string;
  readonly artifact: Exclude<ArtifactKind, "text">;
  readonly affectedChecks: readonly CheckId[];
}

function cannotAnalyze(
  contract: CheckInputContract,
  path: string,
  artifact: Exclude<ArtifactKind, "text">,
): boolean {
  return (
    contract.supportsPath(path) && !contract.acceptedArtifacts.has(artifact)
  );
}

function decisionForEntry(
  entry: UnsupportedIndexEntry,
  policyForFile: FilePolicyResolver,
): UnsupportedInputDecision | undefined {
  const artifact: Exclude<ArtifactKind, "text"> = entry.kind;
  const affectedChecks = Object.freeze(
    CHECK_IDS.filter((checkId) => {
      const contract = inputContractFor(checkId);
      return (
        cannotAnalyze(contract, entry.path, artifact) &&
        policyForFile(checkId, entry.path, "target").severity !== "off"
      );
    }).sort(compareCodeUnits),
  );
  if (affectedChecks.length === 0) return undefined;
  return Object.freeze({
    path: entry.path,
    artifact,
    affectedChecks,
  });
}

export function planUnsupportedInputs(
  entries: readonly UnsupportedIndexEntry[],
  changedPaths: ReadonlySet<string>,
  policyForFile: FilePolicyResolver,
): readonly UnsupportedInputDecision[] {
  return Object.freeze(
    [...entries]
      .filter((entry) => changedPaths.has(entry.path))
      .sort(
        (left, right) =>
          compareCodeUnits(left.path, right.path) ||
          compareCodeUnits(left.kind, right.kind),
      )
      .flatMap((entry) => {
        const decision = decisionForEntry(entry, policyForFile);
        return decision === undefined ? [] : [decision];
      }),
  );
}

function failureForDecision(
  decision: UnsupportedInputDecision,
): ScanFailureInput {
  switch (decision.artifact) {
    case "git-lfs-pointer":
      return {
        code: "GIT_LFS_POINTER",
        message: "Zedbee cannot inspect a staged Git LFS pointer.",
        path: decision.path,
        remediation:
          "Materialize the Git LFS object for this path, stage it again, and rerun the scan.",
      };
    case "submodule":
      return {
        code: "GIT_SUBMODULE_UNAVAILABLE",
        message: "Zedbee cannot inspect a staged Git submodule pointer.",
        path: decision.path,
        remediation:
          "Validate the referenced submodule commit separately or remove the submodule change from this commit, then rerun the scan.",
      };
    case "binary":
      return {
        code: "UNSUPPORTED_BINARY_INPUT",
        message:
          "Zedbee cannot analyze this staged binary file with the enabled checks.",
        path: decision.path,
        remediation:
          "Stage valid text at this path or remove it from the staged change, then rerun the scan.",
      };
  }
}

export function unsupportedEntryFailures(
  entries: readonly UnsupportedIndexEntry[],
  changedPaths: ReadonlySet<string>,
  policyForFile: FilePolicyResolver,
): readonly ScanFailureInput[] {
  return Object.freeze(
    planUnsupportedInputs(entries, changedPaths, policyForFile).map(
      failureForDecision,
    ),
  );
}
