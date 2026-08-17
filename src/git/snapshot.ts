import { lstat, mkdir, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { GitClient } from "./client.js";
import { compareCodeUnits } from "../core/compare.js";
import {
  SNAPSHOT_PREFIX,
  SnapshotError,
  validateSnapshotPath,
} from "./snapshot-path.js";

export { SnapshotError, type SnapshotErrorCode } from "./snapshot-path.js";

export type UnsupportedIndexEntryKind =
  "binary" | "git-lfs-pointer" | "intent-to-add" | "submodule";

export interface UnsupportedIndexEntry {
  path: string;
  kind: UnsupportedIndexEntryKind;
}

export interface SnapshotPair {
  baselineDir: string;
  targetDir: string;
  baselineRef: "HEAD" | null;
  unsupportedEntries: readonly UnsupportedIndexEntry[];
  cleanup(): Promise<void>;
}

interface StagedEntry {
  mode: string;
  path: string;
}

function parseStagedEntries(output: string): StagedEntry[] {
  return output
    .split("\0")
    .filter((record) => record !== "")
    .map((record) => {
      const separator = record.indexOf("\t");
      const header = separator === -1 ? record : record.slice(0, separator);
      return {
        mode: header.split(" ")[0] ?? "",
        path: separator === -1 ? "" : record.slice(separator + 1),
      };
    });
}

function parseIntentToAddPaths(output: string): Set<string> {
  const paths = new Set<string>();
  for (const record of output.split("\0")) {
    if (!record.startsWith("1 ")) {
      continue;
    }
    const fields = record.split(" ");
    if (fields[1] === ".A" && fields.length >= 9) {
      paths.add(fields.slice(8).join(" "));
    }
  }
  return paths;
}

async function readPrefix(path: string): Promise<Buffer> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(8192);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

async function classifyUnsupportedEntries(
  targetDir: string,
  stagedEntries: readonly StagedEntry[],
  intentToAddPaths: ReadonlySet<string>,
): Promise<UnsupportedIndexEntry[]> {
  const unsupported: UnsupportedIndexEntry[] = [];

  for (const entry of stagedEntries) {
    if (entry.mode === "160000") {
      unsupported.push({ path: entry.path, kind: "submodule" });
      continue;
    }
    if (intentToAddPaths.has(entry.path)) {
      unsupported.push({ path: entry.path, kind: "intent-to-add" });
      continue;
    }
    if (entry.mode === "120000") {
      continue;
    }

    const targetPath = join(targetDir, entry.path);
    const metadata = await lstat(targetPath);
    if (!metadata.isFile()) {
      continue;
    }
    const prefix = await readPrefix(targetPath);
    if (prefix.includes(0)) {
      unsupported.push({ path: entry.path, kind: "binary" });
    } else if (
      prefix
        .toString("utf8")
        .startsWith("version https://git-lfs.github.com/spec/v1\n")
    ) {
      unsupported.push({ path: entry.path, kind: "git-lfs-pointer" });
    }
  }

  return unsupported.sort(
    (left, right) =>
      compareCodeUnits(left.path, right.path) ||
      compareCodeUnits(left.kind, right.kind),
  );
}

export async function buildSnapshotPair(
  repositoryRoot: string,
  git: GitClient,
): Promise<SnapshotPair> {
  const unresolved = await git.run(["ls-files", "--unmerged", "-z"]);
  if (unresolved.stdout !== "") {
    throw new SnapshotError(
      "UNRESOLVED_INDEX",
      "Zedbee cannot build a staged snapshot while the index has unresolved entries.",
    );
  }

  const temporaryParent = await mkdtemp(join(tmpdir(), SNAPSHOT_PREFIX));
  const canonicalParent = await validateSnapshotPath(
    await realpath(temporaryParent),
  );
  const baselineDir = join(canonicalParent, "baseline");
  const targetDir = join(canonicalParent, "target");
  const alternateIndex = join(canonicalParent, "baseline-index");
  let cleaned = false;

  const cleanup = async (): Promise<void> => {
    if (cleaned) {
      return;
    }
    try {
      await lstat(canonicalParent);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        cleaned = true;
        return;
      }
      throw error;
    }

    const validatedParent = await validateSnapshotPath(canonicalParent);
    if (validatedParent !== canonicalParent) {
      throw new SnapshotError(
        "INVALID_TEMP_PATH",
        "Zedbee refused to clean a temporary path whose identity changed.",
      );
    }
    await rm(canonicalParent, { recursive: true, force: false });
    cleaned = true;
  };

  try {
    await mkdir(baselineDir);
    await mkdir(targetDir);

    const stagedEntries = parseStagedEntries(
      (await git.run(["ls-files", "--stage", "-z"])).stdout,
    );
    const intentToAddPaths = parseIntentToAddPaths(
      (
        await git.run([
          "status",
          "--porcelain=v2",
          "--untracked-files=no",
          "-z",
        ])
      ).stdout,
    );

    await git.run([
      "checkout-index",
      "--all",
      "--force",
      `--prefix=${targetDir}${sep}`,
    ]);

    const unsupportedEntries = await classifyUnsupportedEntries(
      targetDir,
      stagedEntries,
      intentToAddPaths,
    );

    const head = await git.tryRun(["rev-parse", "--verify", "HEAD"]);
    const baselineRef = head.exitCode === 0 ? "HEAD" : null;
    if (baselineRef === "HEAD") {
      const env = { GIT_INDEX_FILE: alternateIndex };
      await git.run(["read-tree", "HEAD"], { env });
      await git.run(
        ["checkout-index", "--all", "--force", `--prefix=${baselineDir}${sep}`],
        { env },
      );
    }

    return {
      baselineDir,
      targetDir,
      baselineRef,
      unsupportedEntries,
      cleanup,
    };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
