import type { CheckId } from "../config/schema.js";
import { isSupportedPrettierPath } from "./prettier/supported-path.js";

export type ArtifactKind =
  | "text"
  | "binary"
  | "git-lfs-pointer"
  | "submodule";

export interface CheckInputContract {
  readonly checkId: CheckId;
  readonly supportsPath: (repositoryPath: string) => boolean;
  readonly acceptedArtifacts: ReadonlySet<ArtifactKind>;
}

const JAVASCRIPT_SOURCE = /\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/iu;
const TYPESCRIPT_SOURCE = /\.(?:ts|tsx|mts|cts)$/iu;
const VULNERABILITY_LOCKFILE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lock|bun\.lockb)$/u;

const TEXT_ARTIFACTS: ReadonlySet<ArtifactKind> = Object.freeze(
  new Set<ArtifactKind>(["text"]),
);

function supportsJavaScriptSource(repositoryPath: string): boolean {
  return JAVASCRIPT_SOURCE.test(repositoryPath);
}

function supportsTypeScriptSource(repositoryPath: string): boolean {
  return TYPESCRIPT_SOURCE.test(repositoryPath);
}

function supportsVulnerabilityLockfile(repositoryPath: string): boolean {
  return VULNERABILITY_LOCKFILE.test(repositoryPath);
}

function supportsAnyPath(): boolean {
  return true;
}

function supportsNoPath(): boolean {
  return false;
}

function contract(
  checkId: CheckId,
  supportsPath: CheckInputContract["supportsPath"],
): CheckInputContract {
  return Object.freeze({
    checkId,
    supportsPath,
    acceptedArtifacts: TEXT_ARTIFACTS,
  });
}

const INPUT_CONTRACTS: Readonly<Record<CheckId, CheckInputContract>> =
  Object.freeze({
    formatting: contract("formatting", isSupportedPrettierPath),
    lint: contract("lint", supportsJavaScriptSource),
    types: contract("types", supportsTypeScriptSource),
    cyclomaticComplexity: contract(
      "cyclomaticComplexity",
      supportsJavaScriptSource,
    ),
    readabilityComplexity: contract(
      "readabilityComplexity",
      supportsJavaScriptSource,
    ),
    structuralSecurity: contract("structuralSecurity", supportsJavaScriptSource),
    secrets: contract("secrets", supportsAnyPath),
    duplication: contract("duplication", supportsNoPath),
    dependencyArchitecture: contract(
      "dependencyArchitecture",
      supportsNoPath,
    ),
    deadCode: contract("deadCode", supportsNoPath),
    reactCorrectness: contract("reactCorrectness", supportsJavaScriptSource),
    reactAccessibility: contract("reactAccessibility", supportsJavaScriptSource),
    vulnerabilities: contract("vulnerabilities", supportsVulnerabilityLockfile),
  });

export function inputContractFor(checkId: CheckId): CheckInputContract {
  return INPUT_CONTRACTS[checkId];
}

export function cannotAnalyzeArtifact(
  checkId: CheckId,
  repositoryPath: string,
  artifact: ArtifactKind,
): boolean {
  const contract = inputContractFor(checkId);
  return (
    contract.supportsPath(repositoryPath) &&
    !contract.acceptedArtifacts.has(artifact)
  );
}
