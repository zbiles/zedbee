import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { readBoundedImportFile } from "../checks/prettier/project-import-capture.js";
import { join } from "node:path";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import { createProjectWorkspace } from "../checks/prettier/project-workspace.js";
import type { ExecutableEvaluatedConfig } from "./types.js";

const STALE =
  "The project Prettier configuration changed after the preview; run zedbee init again.";

export class ExecutableImportStaleError extends Error {
  constructor() {
    super(STALE);
    this.name = "ExecutableImportStaleError";
  }
}

/** All imports in one invocation share the exact same captured input tree. */
export async function verifyExecutableImportProvenance(
  repositoryRoot: string,
  evaluated: readonly ExecutableEvaluatedConfig[],
): Promise<void> {
  const captured = evaluated.filter((entry) => entry.capture !== undefined);
  if (captured.length > 0) {
    const capture = captured[0]!.capture!;
    if (
      capture.version !== 1 ||
      captured.some(
        (entry) =>
          entry.capture!.sha256 !== capture.sha256 ||
          JSON.stringify(entry.capture!.configPaths) !==
            JSON.stringify(capture.configPaths),
      )
    )
      throw new ExecutableImportStaleError();
    // This bounded, read-only rebuild also revalidates declared dependency roots,
    // package symlink identities and directory additions/removals. It executes no code.
    const workspace = await createProjectWorkspace({
      repositoryRoot,
      snapshotRoot: repositoryRoot,
      projectRoot: ".",
      captureImportSources: true,
      importConfigPaths: capture.configPaths,
    }).catch(() => {
      throw new ExecutableImportStaleError();
    });
    try {
      if (workspace.importProvenance!.sha256 !== capture.sha256)
        throw new ExecutableImportStaleError();
    } finally {
      await workspace.dispose();
    }
  }
  for (const entry of evaluated) {
    if (entry.capture !== undefined) continue;
    let current: Buffer | undefined;
    try {
      current = await readBoundedImportFile(
        join(repositoryRoot, normalizeRepositoryRelativePath(entry.path)),
        await realpath(repositoryRoot),
      );
    } catch {
      /* Stale or unsafe path. */
    }
    if (
      current === undefined ||
      createHash("sha256").update(current).digest("hex") !== entry.sha256
    )
      throw new ExecutableImportStaleError();
  }
}
