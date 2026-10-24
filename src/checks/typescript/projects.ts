import { relative, sep } from "node:path";
import type * as ts from "typescript";
import type { CapturedDependencies } from "../../cache/captured-dependencies.js";
import type { SnapshotSide } from "../../config/file-policy.js";
import type { WorkspaceInspection } from "../../inspection/types.js";
import { CheckIncompleteError } from "../incomplete-error.js";
import { analyzerDiagnostic, type AnalyzerOperation } from "../diagnostics.js";
import { createSnapshotProgram } from "./compiler-host.js";
import {
  loadSnapshotProgramProjects,
  SnapshotConfigurationError,
} from "./config.js";

export interface SnapshotProjectSet {
  readonly canonicalRoot: string;
  readonly programs: readonly ts.Program[];
  readonly covered: ReadonlySet<string>;
  readonly projectPaths: readonly string[];
  readonly files: Readonly<Record<string, string>>;
}

/** Both type diagnostics and typed lint use the same configured source coverage. */
export async function loadSnapshotProjectSet(
  snapshotRoot: string,
  repositoryRoot: string,
  workspace: WorkspaceInspection,
  dependencies?: CapturedDependencies,
): Promise<SnapshotProjectSet> {
  const projects = await loadSnapshotProgramProjects(
    snapshotRoot,
    repositoryRoot,
    workspace,
  );
  const canonicalRoot = projects[0]!.input.snapshotRoot ?? snapshotRoot;
  const programs = projects.flatMap(
    ({ input }) =>
      createSnapshotProgram({
        ...input,
        ...(dependencies === undefined ? {} : { dependencies }),
      }).programs,
  );
  const covered = new Set(
    programs.flatMap((program) =>
      program
        .getSourceFiles()
        .map((source) =>
          relative(canonicalRoot, source.fileName).split(sep).join("/"),
        ),
    ),
  );
  return {
    canonicalRoot,
    programs: Object.freeze(programs),
    covered,
    projectPaths: Object.freeze(projects.map(({ configPath }) => configPath)),
    files: projects.at(-1)!.input.files,
  };
}

export function configurationIncompleteError(
  error: unknown,
  checkId: "types" | "lint",
  side: SnapshotSide,
  operation: AnalyzerOperation = "collect",
): CheckIncompleteError | undefined {
  if (!(error instanceof SnapshotConfigurationError)) return undefined;
  const codes = error.codes.map((code) => `TS${code}`);
  return new CheckIncompleteError({
    code: `TYPESCRIPT_CONFIG_${codes.length === 0 ? "INVALID" : codes.join("_")}`,
    message: `TypeScript configuration could not be loaded${codes.length === 0 ? "" : ` (${codes.join(", ")})`}.`,
    remediation:
      "Correct the identified configuration and its contained extends or project references in the failing snapshot, then retry.",
    path: error.configPath,
    projectPaths: [error.configPath],
    snapshot: side === "baseline" ? "last-commit" : "staged",
    diagnostic: {
      ...analyzerDiagnostic(checkId, operation, "startup"),
      snapshot: side,
    },
  });
}
