import { ESLint } from "eslint";
import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";
import { managedConfig, type ManagedConfigOptions } from "./managed-config.js";
import { analysisKey, analysisStore } from "../analysis-reuse.js";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
} from "../../inspection/read-json.js";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";

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

const rawComplexity = Symbol("common complexity traversal");

class ManagedEslint extends ESLint {
  readonly #cwd: string;
  readonly #mode: ManagedConfigOptions["mode"];
  readonly #identity: string | undefined;

  constructor(
    options: ConstructorParameters<typeof ESLint>[0] & { cwd: string },
    mode: ManagedConfigOptions["mode"],
    identity: string | undefined,
  ) {
    super(options);
    this.#cwd = options.cwd;
    this.#mode = mode;
    this.#identity = identity;
  }

  override async lintFiles(
    patterns: string | string[],
  ): Promise<ESLint.LintResult[]> {
    const paths = typeof patterns === "string" ? [patterns] : patterns;
    for (const path of paths) await assertInspectorPath(this.#cwd, path);
    const store = analysisStore<Promise<ESLint.LintResult[]>>(rawComplexity);
    if (store === undefined) return super.lintFiles(patterns);
    const root = await canonicalizeSnapshotRoot(this.#cwd);
    const registry = await captureSnapshotRegistry(root, paths);
    const results: ESLint.LintResult[] = [];
    for (const path of [...new Set(paths)]) {
      if (registry.resolve(path) === undefined) continue;
      // Read through the existing trusted boundary on every use. A session is
      // not filesystem immutability and timestamps are not a source identity.
      const source = await readContainedFile(registry, path);
      const filePath = resolve(this.#cwd, path);
      const key =
        this.#mode === "complexity" && this.#identity !== undefined
          ? analysisKey([this.#identity, filePath, source])
          : undefined;
      let pending = key === undefined ? undefined : store.get(key);
      if (pending === undefined) {
        pending = super.lintText(source, { filePath });
        if (key !== undefined)
          store.set(key, pending, source.length * 32 + 4096);
      }
      try {
        results.push(...structuredClone(await pending));
      } catch (error) {
        if (key !== undefined) store.delete(key);
        throw error;
      }
    }
    return results;
  }
}

export function createManagedEslint(options: ManagedEslintOptions): ESLint {
  const { cwd, ...configOptions } = options;
  return new ManagedEslint(
    {
      cwd,
      overrideConfigFile: true,
      overrideConfig: [...managedConfig(configOptions)],
      fix: false,
      errorOnUnmatchedPattern: false,
      globInputPaths: false,
      ignore: false,
    },
    options.mode,
    analysisKey(configOptions),
  );
}
