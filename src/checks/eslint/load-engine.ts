import { ESLint } from "eslint";
import { realpath, stat } from "node:fs/promises";
import { MANAGED_SOURCE_PATH } from "../../inspection/source-paths.js";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { managedConfig, type ManagedConfigOptions } from "./managed-config.js";
import { ManagedEslintFailure } from "./failure.js";
import { analysisKey, analysisStore } from "../analysis-reuse.js";
import {
  canonicalizeSnapshotRoot,
  readContainedFile,
} from "../../inspection/read-json.js";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";
import {
  capturedSourceInput,
  capturedSourceRegistry,
  hasAnalysisSourceCapture,
} from "../../inspection/source-capture.js";

export interface ManagedEslintOptions extends ManagedConfigOptions {
  readonly cwd: string;
}

const windowsDrivePath = /^[A-Za-z]:/u;

function invalidInspectorPath(path: string): Error {
  return new Error(`Invalid inspector source path: ${JSON.stringify(path)}`);
}

function escapesRoot(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  );
}

async function assertInspectorPath(
  cwd: string,
  path: string,
  canonicalRoot: () => Promise<string>,
): Promise<void> {
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
    !MANAGED_SOURCE_PATH.test(path)
  ) {
    throw invalidInspectorPath(path);
  }

  const captured = capturedSourceInput(cwd, path);
  if (captured !== undefined) {
    if (captured.entry !== undefined && captured.entry.targetKind !== "file") {
      throw invalidInspectorPath(path);
    }
    return;
  }
  try {
    const [root, canonicalTarget] = await Promise.all([
      canonicalRoot(),
      realpath(target),
    ]);
    const canonicalRelative = relative(root, canonicalTarget);
    if (escapesRoot(canonicalRelative)) {
      throw invalidInspectorPath(path);
    }
    const targetStats = await stat(canonicalTarget);
    if (!targetStats.isFile()) {
      throw invalidInspectorPath(path);
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
    let rootPromise: Promise<string> | undefined;
    const canonicalRoot = (): Promise<string> =>
      (rootPromise ??= realpath(this.#cwd));
    for (const path of paths)
      await assertInspectorPath(this.#cwd, path, canonicalRoot);
    const store = analysisStore<Promise<ESLint.LintResult[]>>(rawComplexity);
    if (store === undefined && !hasAnalysisSourceCapture())
      return super.lintFiles(patterns);
    const root = await canonicalizeSnapshotRoot(this.#cwd);
    const livePaths = paths.filter(
      (path) => capturedSourceInput(root, path) === undefined,
    );
    const liveRegistry = await captureSnapshotRegistry(root, livePaths);
    const results: ESLint.LintResult[] = [];
    for (const path of [...new Set(paths)]) {
      const registry = capturedSourceRegistry(root, [path]) ?? liveRegistry;
      if (registry.resolve(path) === undefined) continue;
      // Parser ownership alone remains live; only an explicit input view
      // supplies previously acquired bytes through the trusted boundary.
      const source = await readContainedFile(registry, path);
      const filePath = resolve(this.#cwd, path);
      const key =
        this.#mode === "complexity" && this.#identity !== undefined
          ? analysisKey([this.#identity, filePath, source])
          : undefined;
      let pending = key === undefined ? undefined : store?.get(key);
      if (pending === undefined) {
        pending = super.lintText(source, { filePath });
        if (key !== undefined)
          store?.set(key, pending, source.length * 32 + 4096);
      }
      try {
        results.push(...structuredClone(await pending));
      } catch (error) {
        if (key !== undefined) store?.delete(key);
        throw new ManagedEslintFailure(path, error);
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
