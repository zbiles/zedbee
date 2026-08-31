import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { releaseMetadata, type ReleaseMetadata } from "./metadata.js";

export const UPDATE_INTERVAL = 24 * 60 * 60 * 1000;
export const UPDATE_MAX_AGE = 7 * UPDATE_INTERVAL;

export interface UpdateCache {
  readonly checkedAt: number;
  readonly metadata: ReleaseMetadata | null;
}

export function updateCachePath(
  env: Readonly<Record<string, string | undefined>>,
): string {
  const configured = env.XDG_CACHE_HOME;
  const root =
    configured !== undefined && isAbsolute(configured)
      ? configured
      : join(homedir(), ".cache");
  return join(root, "zedbee", "update.json");
}

export function readUpdateCache(
  path: string,
  now = Date.now(),
): UpdateCache | undefined {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile() || stat.size > 4096) return undefined;
    const entry = JSON.parse(readFileSync(descriptor, "utf8")) as Record<
      string,
      unknown
    > | null;
    if (
      entry === null ||
      typeof entry.checkedAt !== "number" ||
      !Number.isSafeInteger(entry.checkedAt) ||
      entry.checkedAt < 0 ||
      entry.checkedAt > now
    )
      return undefined;
    const metadata =
      entry.metadata === null ? null : releaseMetadata(entry.metadata);
    if (metadata === undefined) return undefined;
    return { checkedAt: entry.checkedAt, metadata };
  } catch {
    return undefined;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function prepareUpdateDirectory(path: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(directory);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (process.getuid !== undefined && stat.uid !== process.getuid())
  ) {
    throw new Error("Update cache directory is not owned by this user.");
  }
}

export function writeUpdateCache(path: string, entry: UpdateCache): void {
  prepareUpdateDirectory(path);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(entry), {
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      /* Renamed or never created. */
    }
  }
}
