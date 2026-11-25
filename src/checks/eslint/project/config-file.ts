import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { isContainedPath } from "../../../inspection/read-json.js";

const FLAT_CONFIG_NAMES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
];
const OTHER_CONFIG_NAMES = [
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yml",
  ".eslintrc.yaml",
];

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
      ? [...FLAT_CONFIG_NAMES, ...OTHER_CONFIG_NAMES]
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
