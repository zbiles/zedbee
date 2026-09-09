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
import type { ScanMode } from "./source-mode.js";

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
  mode: ScanMode,
): ScanFailureInput {
  const committed = mode === "base";
  switch (decision.artifact) {
    case "git-lfs-pointer":
      return {
        code: "GIT_LFS_POINTER",
        message: committed
          ? "Zedbee cannot inspect a Git LFS pointer in the committed target."
          : "Zedbee cannot inspect a staged Git LFS pointer.",
        path: decision.path,
        remediation: committed
          ? "Validate the referenced Git LFS object separately. To scan this path with Zedbee, deliberately convert an appropriate text file to ordinary Git tracking, review and commit it, then rerun the scan."
          : "Staging a file tracked by Git LFS creates another pointer. Validate the referenced object separately. To scan this path with Zedbee, deliberately convert an appropriate text file to ordinary Git tracking, then review, stage, and scan again.",
      };
    case "submodule":
      return {
        code: "GIT_SUBMODULE_UNAVAILABLE",
        message: committed
          ? "Zedbee cannot inspect a Git submodule pointer in the committed target."
          : "Zedbee cannot inspect a staged Git submodule pointer.",
        path: decision.path,
        remediation:
          "Validate the referenced submodule commit separately or remove the submodule change from this commit, then rerun the scan.",
      };
    case "binary":
      return {
        code: "UNSUPPORTED_BINARY_INPUT",
        message: committed
          ? "Zedbee cannot analyze this binary file in the committed target with the enabled checks."
          : "Zedbee cannot analyze this staged binary file with the enabled checks.",
        path: decision.path,
        remediation: committed
          ? "Commit valid text at this path or remove it from the committed target, then rerun the scan."
          : "Stage valid text at this path or remove it from the staged change, then rerun the scan.",
      };
  }
}

export function unsupportedEntryFailures(
  entries: readonly UnsupportedIndexEntry[],
  changedPaths: ReadonlySet<string>,
  policyForFile: FilePolicyResolver,
  mode: ScanMode,
): readonly ScanFailureInput[] {
  return Object.freeze(
    planUnsupportedInputs(entries, changedPaths, policyForFile).map(
      (decision) => failureForDecision(decision, mode),
    ),
  );
}
