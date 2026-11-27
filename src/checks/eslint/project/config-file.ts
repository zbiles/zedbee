import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isContainedPath } from "../../../inspection/read-json.js";

import { ESLINT_CONFIG_FILE_NAMES, SUPPORTED_ESLINT_CONFIG_FILE_NAMES } from "./config-files.js";
const FLAT_CONFIG_NAMES: readonly string[] = SUPPORTED_ESLINT_CONFIG_FILE_NAMES;

export async function findProjectEslintConfig(
  root: string,
  project: string,
  mode: "doctor" | "mirror",
): Promise<{ path?: string; supported: boolean }> {
  let other: string | undefined;
  for (
    let dir = resolve(root, project);
    isContainedPath(root, dir);
    dir = dirname(dir)
  ) {
    for (const name of mode === "doctor"
      ? ESLINT_CONFIG_FILE_NAMES
      : FLAT_CONFIG_NAMES) {
      const path = join(dir, name);
      const state = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (!state) continue;
      if (
        FLAT_CONFIG_NAMES.includes(name) &&
        (state.isFile() || (mode === "mirror" && state.isSymbolicLink()))
      )
        return { path, supported: true };
      other ??= path;
    }
    if (dir === root) break;
  }
  return other === undefined
    ? { supported: false }
    : { path: other, supported: false };
}
