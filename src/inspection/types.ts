export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "unknown";

export type Environment =
  | "javascript"
  | "typescript"
  | "react"
  | "react-dom"
  | "ink"
  | "next"
  | "remix"
  | "vitest"
  | "jest"
  | "testing-library";

export interface WorkspaceInspection {
  readonly name?: string;
  readonly relativeRoot: string;
  readonly manifestPath: string;
  readonly sourceFiles: readonly string[];
  readonly tsconfigPaths: readonly string[];
  readonly environments: readonly Environment[];
  readonly productionDependencies?: readonly string[];
  readonly developmentDependencies?: readonly string[];
}

export interface RepositoryInspection {
  readonly snapshotRoot: string;
  readonly packageManager: PackageManager;
  readonly lockfiles: readonly string[];
  readonly workspaces: readonly WorkspaceInspection[];
}

export type RepositoryInspectionErrorCode =
  "INVALID_SNAPSHOT_DATA" | "UNSAFE_SNAPSHOT_PATH";

export class RepositoryInspectionError extends Error {
  readonly code: RepositoryInspectionErrorCode;

  constructor(code: RepositoryInspectionErrorCode, message: string) {
    super(message);
    this.name = "RepositoryInspectionError";
    this.code = code;
  }
}
