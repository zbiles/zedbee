import type { Stats } from "node:fs";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

/** True when the entry is owned by this user and not group/other accessible. Always true on Windows. */
export function hasPrivateOwnership(stat: Stats): boolean {
  return (
    process.platform === "win32" ||
    (stat.uid === process.getuid?.() && (stat.mode & 0o077) === 0)
  );
}

/** Writes contents to a fresh temp file in `directory`, then renames it onto `target`. */
export function writePrivateFileAtomically(
  directory: string,
  target: string,
  contents: string,
): void {
  const temporary = join(directory, `${randomUUID()}.tmp`);
  try {
    writeFileSync(temporary, contents, { flag: "wx", mode: 0o600 });
    renameSync(temporary, target);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {}
  }
}
