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

export type DependencySection =
  | "dependencies"
  | "optionalDependencies"
  | "devDependencies"
  | "peerDependencies";

export interface DependencyDeclaration {
  readonly name: string;
  readonly specifier: string;
  readonly section: DependencySection;
}

export interface WorkspaceInspection {
  readonly name?: string;
  readonly relativeRoot: string;
  readonly manifestPath: string;
  readonly sourceFiles: readonly string[];
  readonly tsconfigPaths: readonly string[];
  readonly environments: readonly Environment[];
  readonly dependencyDeclarations: readonly DependencyDeclaration[];
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

  readonly path?: string;
  readonly reason?: "unresolved-symlink" | "external-symlink";

  constructor(
    code: RepositoryInspectionErrorCode,
    message: string,
    link?: { path: string; reason: "unresolved-symlink" | "external-symlink" },
  ) {
    super(message);
    this.name = "RepositoryInspectionError";
    this.code = code;
    if (link !== undefined) {
      this.path = link.path;
      this.reason = link.reason;
    }
  }
}
