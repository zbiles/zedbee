import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  realpath,
  rm,
  unlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { GitClient } from "./client.js";
import { compareCodeUnits } from "../core/compare.js";
import {
  SNAPSHOT_PREFIX,
  SnapshotError,
  validateSnapshotPath,
} from "./snapshot-path.js";

export { SnapshotError, type SnapshotErrorCode } from "./snapshot-path.js";

export type UnsupportedIndexEntryKind =
  "binary" | "git-lfs-pointer" | "submodule";

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

const INTENT_TO_ADD_FLAG = 0x20000000;
const INDEX_DEBUG_METADATA =
  /^  ctime: \d+:\d+\n  mtime: \d+:\d+\n  dev: \d+\tino: \d+\n  uid: \d+\tgid: \d+\n  size: \d+\tflags: ([\da-f]+)(?:\n|$)/;

function parseIntentToAddPaths(output: string): Set<string> {
  const paths = new Set<string>();
  let remaining = output;
  while (remaining !== "") {
    const pathEnd = remaining.indexOf("\0");
    if (pathEnd === -1) {
      throw new Error("Git returned invalid index debug metadata.");
    }
    const path = remaining.slice(0, pathEnd);
    const metadata = remaining.slice(pathEnd + 1);
    const match = INDEX_DEBUG_METADATA.exec(metadata);
    if (match === null) {
      throw new Error("Git returned invalid index debug metadata.");
    }
    const flags = Number.parseInt(match[1]!, 16);
    if ((flags & INTENT_TO_ADD_FLAG) !== 0) {
      paths.add(path);
    }
    remaining = metadata.slice(match[0].length);
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
): Promise<UnsupportedIndexEntry[]> {
  const unsupported: UnsupportedIndexEntry[] = [];

  for (const entry of stagedEntries) {
    if (entry.mode === "160000") {
      unsupported.push({ path: entry.path, kind: "submodule" });
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

function containedRepositoryPath(
  repositoryRoot: string,
  repositoryPath: string,
): string | undefined {
  if (isAbsolute(repositoryPath)) {
    return undefined;
  }
  const candidate = resolve(repositoryRoot, repositoryPath);
  const fromRoot = relative(repositoryRoot, candidate);
  if (
    fromRoot === "" ||
    isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`)
  ) {
    return undefined;
  }
  return candidate;
}

async function removeIntentToAddPlaceholders(
  targetDir: string,
  intentToAddPaths: ReadonlySet<string>,
): Promise<void> {
  for (const repositoryPath of intentToAddPaths) {
    const targetPath = containedRepositoryPath(targetDir, repositoryPath);
    if (targetPath === undefined) {
      throw new Error("Zedbee refused an invalid intent-to-add path.");
    }
    let metadata;
    try {
      metadata = await lstat(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    if (!metadata.isFile()) {
      throw new Error("Zedbee refused a non-file intent-to-add placeholder.");
    }
    await unlink(targetPath);
  }
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
      (await git.run(["ls-files", "--debug", "-z"])).stdout,
    );

    await git.run([
      "checkout-index",
      "--all",
      "--force",
      `--prefix=${targetDir}${sep}`,
    ]);

    await removeIntentToAddPlaceholders(targetDir, intentToAddPaths);

    const unsupportedEntries = await classifyUnsupportedEntries(
      targetDir,
      stagedEntries.filter((entry) => !intentToAddPaths.has(entry.path)),
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
