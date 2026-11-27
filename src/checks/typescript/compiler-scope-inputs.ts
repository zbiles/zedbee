import { configCandidates } from "./config-candidates.js";
import type * as ts from "typescript";
import { posix, resolve, relative, sep } from "node:path";
import { parse, type ParseError } from "jsonc-parser";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";
import {
  readContainedFile,
  ContainedFileSizeError,
} from "../../inspection/read-json.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";
export interface ScopeProject {
  readonly configPath: string;
  readonly options: ts.CompilerOptions;
  readonly rootPaths: readonly string[];
  readonly sourcePaths: readonly string[];
}
export type CompilerScopeInputs =
  | Readonly<{
      complete: true;
      projects: readonly ScopeProject[];
      inputPaths: ReadonlySet<string>;
    }>
  | Readonly<{
      complete: false;
      reason: "unsupported" | "unreadable" | "limit";
    }>;
class ProofLimit extends Error {}
class Unsupported extends Error {}
/** No programs, executable configs or live source reads. The caller owns this
 * temporary bounded view; it is never retained in a global graph cache. */
export async function loadCompilerScopeInputs(
  inspection: RepositoryInspection,
  workspace: WorkspaceInspection,
  signal?: AbortSignal,
): Promise<CompilerScopeInputs> {
  signal?.throwIfAborted();
  try {
    const sources = [...new Set(workspace.sourceFiles)];
    if (sources.length > 500 || workspace.tsconfigPaths.length > 64)
      throw new ProofLimit();
    if (workspace.tsconfigPaths.length === 0) throw new Unsupported();
    let retained = 0;
    const files = new Map<string, string>();
    const inputPaths = new Set<string>();
    const configs = new Map<string, Record<string, unknown>>();
    const visiting = new Set<string>();
    const referenced = new Set<string>();
    const extended = new Set<string>();
    const read = async (path: string, limit: number) => {
      signal?.throwIfAborted();
      const registry = await captureSnapshotRegistry(inspection.snapshotRoot, [
        path,
      ]);
      signal?.throwIfAborted();
      // Alias targets and their relative resolution can change independently. Do
      // not optimize a graph containing links, including links in parent paths.
      if (registry.entries().some((e) => e.kind === "symlink"))
        throw new Unsupported();
      const remaining = Math.floor((8 * 1024 * 1024 - retained) / 2);
      if (remaining <= 0) throw new ProofLimit();
      const text = await readContainedFile(registry, path, {
        maxBytes: Math.min(limit, remaining),
      });
      signal?.throwIfAborted();
      retained += text.length * 2;
      if (retained > 8 * 1024 * 1024) throw new ProofLimit();
      files.set(resolve(inspection.snapshotRoot, path), text);
      inputPaths.add(path);
      return text;
    };
    // Dynamic import preserves TypeScript's lazy startup on non-source scans.
    const [{ validateConfigPaths, configHost }, typescript] = await Promise.all(
      [import("./config.js"), import("typescript")],
    );
    signal?.throwIfAborted();
    const locate = async (
      from: string,
      request: unknown,
      kind: "extends" | "reference",
    ) => {
      if (
        typeof request !== "string" ||
        !request ||
        request.includes("\\") ||
        posix.isAbsolute(request) ||
        /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(request)
      )
        throw new Unsupported();
      const base = posix.normalize(posix.join(posix.dirname(from), request));
      if (base === ".." || base.startsWith("../")) throw new Unsupported();
      for (const candidate of configCandidates(base, kind)) {
        signal?.throwIfAborted();
        const registry = await captureSnapshotRegistry(
          inspection.snapshotRoot,
          [candidate],
        );
        if (registry.resolve(candidate)?.targetKind === "file")
          return candidate;
      }
      throw new Unsupported();
    };
    const load = async (path: string): Promise<void> => {
      signal?.throwIfAborted();
      if (visiting.has(path)) throw new Unsupported();
      if (configs.has(path)) return;
      if (configs.size >= 64) throw new ProofLimit();
      const text = await read(path, 64 * 1024);
      const errors: ParseError[] = [];
      const data: unknown = parse(text, errors, { allowTrailingComma: true });
      if (
        errors.length ||
        !data ||
        typeof data !== "object" ||
        Array.isArray(data)
      )
        throw new Unsupported();
      validateConfigPaths(path, data);
      const config = data as Record<string, unknown>;
      configs.set(path, config);
      visiting.add(path);
      const extensions =
        config.extends === undefined
          ? []
          : Array.isArray(config.extends)
            ? config.extends
            : [config.extends];
      for (const extension of extensions) {
        const next = await locate(path, extension, "extends");
        extended.add(next);
        await load(next);
      }
      for (const ref of (config.references ?? []) as { path: unknown }[]) {
        const next = await locate(path, ref.path, "reference");
        referenced.add(next);
        await load(next);
      }
      visiting.delete(path);
    };
    for (const path of workspace.tsconfigPaths) await load(path);
    for (const path of sources) await read(path, 1024 * 1024);
    const canonical =
      workspace.relativeRoot === "."
        ? "tsconfig.json"
        : `${workspace.relativeRoot}/tsconfig.json`;
    // Root discovery uses the full captured names, without loading foreign
    // source text. A reference/include outside our bounded source view cannot
    // silently become an empty, supposedly covered project.
    const inventory = new Map(files);
    let inventoryBytes = 0;
    for (const side of inspection.workspaces)
      for (const path of side.sourceFiles) {
        inventoryBytes += path.length * 2 + 128;
        if (inventory.size >= 20000 || inventoryBytes > 4 * 1024 * 1024)
          throw new ProofLimit();
        const absolute = resolve(inspection.snapshotRoot, path);
        if (!inventory.has(absolute)) inventory.set(absolute, "");
      }
    const projects: ScopeProject[] = [];
    for (const [configPath, config] of configs) {
      if (
        configPath !== canonical &&
        extended.has(configPath) &&
        !referenced.has(configPath) &&
        config.files === undefined &&
        config.include === undefined &&
        config.references === undefined
      )
        continue;
      if (projects.length >= 32) throw new ProofLimit();
      const absolute = resolve(inspection.snapshotRoot, configPath);
      const parsed = typescript.parseJsonConfigFileContent(
        config,
        configHost(inspection.snapshotRoot, inventory),
        resolve(absolute, ".."),
        undefined,
        absolute,
      );
      if (parsed.errors.some((e) => e.code !== 18002 && e.code !== 18003))
        throw new Unsupported();
      const rootPaths = parsed.fileNames.map((path) =>
        relative(inspection.snapshotRoot, path).split(sep).join("/"),
      );
      if (rootPaths.some((path) => !sources.includes(path)))
        throw new Unsupported();
      projects.push({
        configPath,
        options: parsed.options,
        rootPaths,
        sourcePaths: rootPaths,
      });
    }
    const covered = new Set(projects.flatMap((project) => project.rootPaths));
    const first = projects[0];
    if (first !== undefined)
      projects[0] = {
        ...first,
        sourcePaths: [
          ...first.sourcePaths,
          ...sources.filter((path) => !covered.has(path)),
        ],
      };
    signal?.throwIfAborted();
    return { complete: true, projects, inputPaths };
  } catch (error) {
    signal?.throwIfAborted();
    return {
      complete: false,
      reason:
        error instanceof ProofLimit || error instanceof ContainedFileSizeError
          ? "limit"
          : error instanceof Unsupported || error instanceof TypeError
            ? "unsupported"
            : "unreadable",
    };
  }
}
