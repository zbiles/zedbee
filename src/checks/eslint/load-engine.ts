import { ESLint } from "eslint";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { managedConfig, type ManagedConfigOptions } from "./managed-config.js";

export interface ManagedEslintOptions extends ManagedConfigOptions {
  readonly cwd: string;
}

const sourceExtensions = new Set([
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
]);
const windowsDrivePath = /^[A-Za-z]:/u;

async function assertInspectorPath(cwd: string, path: string): Promise<void> {
  const segments = path.split("/");
  const target = resolve(cwd, ...segments);
  const fromRoot = relative(cwd, target);
  if (
    path.length === 0 ||
    path.includes("\\") ||
    isAbsolute(path) ||
    windowsDrivePath.test(path) ||
    segments.some(
      (segment) => segment === "" || segment === "." || segment === "..",
    ) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot) ||
    !sourceExtensions.has(extname(path))
  ) {
    throw new Error(`Invalid inspector source path: ${JSON.stringify(path)}`);
  }

  try {
    const [canonicalRoot, canonicalTarget] = await Promise.all([
      realpath(cwd),
      realpath(target),
    ]);
    const canonicalRelative = relative(canonicalRoot, canonicalTarget);
    if (
      canonicalRelative === ".." ||
      canonicalRelative.startsWith(`..${sep}`) ||
      isAbsolute(canonicalRelative)
    ) {
      throw new Error(`Invalid inspector source path: ${JSON.stringify(path)}`);
    }
    const targetStats = await stat(canonicalTarget);
    if (!targetStats.isFile()) {
      throw new Error(`Invalid inspector source path: ${JSON.stringify(path)}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error;
  }
}

class ManagedEslint extends ESLint {
  readonly #cwd: string;

  constructor(
    options: ConstructorParameters<typeof ESLint>[0] & { cwd: string },
  ) {
    super(options);
    this.#cwd = options.cwd;
  }

  override async lintFiles(
    patterns: string | string[],
  ): Promise<ESLint.LintResult[]> {
    const paths = typeof patterns === "string" ? [patterns] : patterns;
    for (const path of paths) await assertInspectorPath(this.#cwd, path);
    return super.lintFiles(patterns);
  }
}

export function createManagedEslint(options: ManagedEslintOptions): ESLint {
  const { cwd, ...configOptions } = options;
  return new ManagedEslint({
    cwd,
    overrideConfigFile: true,
    overrideConfig: [...managedConfig(configOptions)],
    fix: false,
    errorOnUnmatchedPattern: false,
    globInputPaths: false,
    ignore: false,
  });
}
