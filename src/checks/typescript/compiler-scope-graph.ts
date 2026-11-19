import { setImmediate as yieldTurn } from "node:timers/promises";
import { builtinModules } from "node:module";
import { createHash } from "node:crypto";
import { dirname, resolve, relative, sep, isAbsolute } from "node:path";
import pLimit from "p-limit";
import type * as Typescript from "typescript";
import type { InspectionContext } from "../adapter.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";
import {
  CapturedDependencies,
  type DependencyCaptureContext,
} from "../../cache/captured-dependencies.js";
import type { DependencyInputManifest } from "../../cache/dependency-inputs.js";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";
import { readContainedFile } from "../../inspection/read-json.js";
import { classifyCompilerChanges } from "../compiler-change-inputs.js";
import { CheckIncompleteError } from "../incomplete-error.js";
import { loadCompilerScopeInputs } from "./compiler-scope-inputs.js";
export interface WorkspaceIndependenceProof {
  readonly independent: boolean;
  readonly reason:
    "disjoint-inputs" | "changed-input" | "dependency" | "unknown" | "limit";
}
interface Witness {
  root: string;
  path: string;
  digest: string;
  limit: number;
}
interface ProofRecord {
  key: string;
  manifest: DependencyInputManifest;
  context: DependencyCaptureContext;
  witnesses: Witness[];
}
interface Owner {
  invalidated: boolean;
  records: Map<string, ProofRecord>;
  bytes: number;
  ids: WeakMap<object, number>;
  next: number;
}
const owners = new WeakMap<RepositoryInspection, Owner>();
// A proof may temporarily own a full dependency capture. Serialize acquisition
// and cap retained witness metadata separately, below the reuse owner's budget.
const acquire = pLimit(1);
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const unknown: WorkspaceIndependenceProof = {
  independent: false,
  reason: "unknown",
};
function within(root: string, path: string) {
  const part = relative(root, path);
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`))
  );
}
async function read(
  root: string,
  path: string,
  limit: number,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const registry = await captureSnapshotRegistry(root, [path]);
  if (registry.entries().some((e) => e.kind === "symlink"))
    throw Error("Unsupported proof input");
  const text = await readContainedFile(registry, path, { maxBytes: limit });
  signal?.throwIfAborted();
  return text;
}
async function valid(record: ProofRecord, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!CapturedDependencies.validate(record.manifest, record.context))
    return false;
  for (const w of record.witnesses)
    if (hash(await read(w.root, w.path, w.limit, signal)) !== w.digest)
      return false;
  signal?.throwIfAborted();
  return true;
}
/** Required after analyzer work, before allowing any result based on a skip. */
export async function validateCompilerScopeProofs(
  context: InspectionContext,
): Promise<void> {
  const signal = context.signal;
  const owner = owners.get(context.targetInspection);
  if (!owner) return;
  if (owner.invalidated)
    throw new CheckIncompleteError({
      code: "COMPARISON_INPUTS_CHANGED",
      message:
        "Inputs used to select compiler checks changed during this scan.",
      remediation:
        "Wait for dependency installation or file updates to finish, then rerun the scan.",
    });
  for (const record of owner.records.values()) {
    let verified = false;
    try {
      verified = await valid(record, signal);
    } catch {
      signal?.throwIfAborted();
    }
    if (!verified)
      throw new CheckIncompleteError({
        code: "COMPARISON_INPUTS_CHANGED",
        message:
          "Inputs used to select compiler checks changed during this scan.",
        remediation:
          "Wait for dependency installation or file updates to finish, then rerun the scan.",
      });
  }
}
export function releaseCompilerScopeProofs(context: InspectionContext): void {
  owners.delete(context.targetInspection);
}
function identity(owner: Owner, value: object) {
  let id = owner.ids.get(value);
  if (id === undefined) {
    id = owner.next++;
    owner.ids.set(value, id);
  }
  return id;
}
export async function proveCompilerWorkspaceIndependence(
  context: InspectionContext,
  workspace: WorkspaceInspection,
): Promise<WorkspaceIndependenceProof> {
  context.signal?.throwIfAborted();
  if (
    context.mergeComparison ||
    context.config.checks.lint.when === "always" ||
    context.config.checks.types.when === "always" ||
    context.config.checks.lint.engine === "project"
  )
    return unknown;
  const changes = await classifyCompilerChanges(context);
  if (
    !changes.complete ||
    changes.requiresBroadComparison ||
    changes.sourcePaths.size === 0
  )
    return unknown;
  const prefix =
    workspace.relativeRoot === "." ? "" : `${workspace.relativeRoot}/`;
  if ([...changes.sourcePaths].some((path) => path.startsWith(prefix)))
    return { independent: false, reason: "changed-input" };
  return acquire(async () => {
    context.signal?.throwIfAborted();
    let owner = owners.get(context.targetInspection);
    if (owner === undefined) {
      owner = {
        records: new Map(),
        bytes: 0,
        ids: new WeakMap(),
        next: 0,
        invalidated: false,
      };
      owners.set(context.targetInspection, owner);
    }
    const key =
      owner === undefined
        ? undefined
        : JSON.stringify([
            identity(owner, context.baselineInspection),
            identity(owner, context.targetInspection),
            identity(owner, context.changeSet),
            workspace.relativeRoot,
            context.repositoryRoot,
          ]);
    const previous = key === undefined ? undefined : owner?.records.get(key);
    if (previous !== undefined) {
      try {
        if (await valid(previous, context.signal))
          return { independent: true, reason: "disjoint-inputs" };
      } catch {
        context.signal?.throwIfAborted();
      }
      owner!.invalidated = true;
      owner!.records.delete(key!);
      owner!.bytes -= JSON.stringify(previous).length * 2;
    }
    try {
      const dependencyContext = { repositoryRoot: context.repositoryRoot };
      const dependencies = new CapturedDependencies(dependencyContext);
      const witnesses: Witness[] = [];
      const signatures: Map<string, string>[] = [];
      let edges = 0;
      const librarySeen = new Set<string>();
      const ts = await import("typescript");
      for (const inspection of [
        context.baselineInspection,
        context.targetInspection,
      ]) {
        context.signal?.throwIfAborted();
        if (inspection.workspaces.length > 32)
          return { independent: false, reason: "limit" };
        const side = inspection.workspaces.find(
          (w) => w.relativeRoot === workspace.relativeRoot,
        );
        if (side === undefined) return unknown;
        const inputs = await loadCompilerScopeInputs(
          inspection,
          side,
          context.signal,
        );
        if (!inputs.complete)
          return {
            independent: false,
            reason: inputs.reason === "limit" ? "limit" : "unknown",
          };
        const texts = new Map<string, string>(),
          signature = new Map<string, string>();
        let textBytes = 0;
        const add = async (path: string, limit: number) => {
          const remaining = Math.floor((8 * 1024 * 1024 - textBytes) / 2);
          if (remaining <= 0) throw new Error("Proof text limit");
          const text = await read(
            inspection.snapshotRoot,
            path,
            Math.min(limit, remaining),
            context.signal,
          );
          textBytes += text.length * 2;
          texts.set(resolve(inspection.snapshotRoot, path), text);
          signature.set(path, hash(text));
          witnesses.push({
            root: inspection.snapshotRoot,
            path,
            digest: hash(text),
            limit,
          });
          return text;
        };
        for (const path of inputs.inputPaths)
          await add(
            path,
            side.sourceFiles.includes(path) ? 1024 * 1024 : 64 * 1024,
          );
        // The production host can see all captured repository source files. Resolve
        // their names too; an edge outside this workspace prevents narrowing.
        const inventory = new Set(
          inspection.workspaces
            .flatMap((w) => w.sourceFiles)
            .map((p) => resolve(inspection.snapshotRoot, p)),
        );
        for (const w of inspection.workspaces) {
          inventory.add(resolve(inspection.snapshotRoot, w.manifestPath));
          if (!texts.has(resolve(inspection.snapshotRoot, w.manifestPath)))
            await add(w.manifestPath, 64 * 1024);
        }
        for (const path of texts.keys()) inventory.add(path);
        const directories = new Set<string>();
        for (const path of inventory) {
          let directory = dirname(path);
          while (within(inspection.snapshotRoot, directory)) {
            directories.add(directory);
            if (directory === inspection.snapshotRoot) break;
            directory = dirname(directory);
          }
        }
        const snapshotHost: Typescript.ModuleResolutionHost = {
          fileExists: (path) => inventory.has(resolve(path)),
          readFile: (path) => texts.get(resolve(path)),
          directoryExists: (path) => directories.has(resolve(path)),
          realpath: (path) => resolve(path),
        };
        const libraryRoot = dirname(ts.getDefaultLibFilePath({}));
        const dependencyPath = (path: string) =>
          within(context.repositoryRoot, resolve(path)) ||
          within(libraryRoot, resolve(path));
        const host: Typescript.ModuleResolutionHost = {
          fileExists: (path) =>
            inventory.has(resolve(path)) ||
            (dependencyPath(path) && dependencies.fileExists(path)),
          readFile: (path) =>
            texts.get(resolve(path)) ??
            (dependencyPath(path) ? dependencies.readFile(path) : undefined),
          directoryExists: (path) =>
            directories.has(resolve(path)) ||
            within(context.repositoryRoot, resolve(path)) ||
            (within(libraryRoot, resolve(path)) &&
              dependencies.directoryExists(path)),
          getDirectories: (path) =>
            dependencyPath(path) ? dependencies.getDirectories(path) : [],
          realpath: (path) =>
            inventory.has(resolve(path))
              ? resolve(path)
              : dependencies.realpath(path),
        };
        // Missing declared installs must not disappear behind an optimization. This
        // is intentionally stricter than the analyzer's usage-based diagnosis.
        for (const w of inspection.workspaces.filter(
          (w) => w.relativeRoot === "." || w.relativeRoot === side.relativeRoot,
        ))
          for (const declaration of w.dependencyDeclarations) {
            let directory = resolve(context.repositoryRoot, side.relativeRoot),
              found = false;
            while (within(context.repositoryRoot, directory)) {
              if (
                dependencies.fileExists(
                  resolve(
                    directory,
                    "node_modules",
                    declaration.name,
                    "package.json",
                  ),
                )
              ) {
                found = true;
                break;
              }
              if (directory === resolve(context.repositoryRoot)) break;
              directory = dirname(directory);
            }
            if (!found) return unknown;
          }
        const allowed = new Set(
          side.sourceFiles.map((p) => resolve(inspection.snapshotRoot, p)),
        );
        for (const project of inputs.projects) {
          const options: Typescript.CompilerOptions = {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            ...project.options,
          };
          // Conditional NodeNext/CJS resolution requires usage-specific mode. Keep
          // broad coverage until that variant has an explicit proof implementation.
          if (
            options.moduleResolution !== ts.ModuleResolutionKind.Bundler &&
            options.moduleResolution !== ts.ModuleResolutionKind.Node10
          ) {
            if (JSON.stringify(options.types) !== "[]") return unknown;
            for (const sourcePath of project.sourcePaths) {
              const text = texts.get(
                resolve(inspection.snapshotRoot, sourcePath),
              )!;
              const pre = ts.preProcessFile(text, true, true);
              if (
                pre.importedFiles.length ||
                pre.referencedFiles.length ||
                pre.typeReferenceDirectives.length ||
                pre.libReferenceDirectives.length ||
                /\.d\.[cm]?ts$/iu.test(sourcePath)
              )
                return unknown;
              const tree = ts.createSourceFile(
                sourcePath,
                text,
                ts.ScriptTarget.Latest,
                true,
              );
              if (!ts.isExternalModule(tree)) return unknown;
              let unsafe = false;
              const visit = (node: Typescript.Node) => {
                if (ts.isModuleDeclaration(node) || ts.isCallExpression(node))
                  unsafe = true;
                if (!unsafe) ts.forEachChild(node, visit);
              };
              visit(tree);
              if (unsafe) return unknown;
            }
            continue;
          }
          if (
            options.plugins !== undefined ||
            options.moduleSuffixes ||
            options.rootDirs ||
            options.noResolve ||
            options.typeRoots
          )
            return unknown;
          const typeRoots: string[] = [];
          let directory = resolve(
            context.repositoryRoot,
            dirname(project.configPath),
          );
          while (within(context.repositoryRoot, directory)) {
            typeRoots.push(resolve(directory, "node_modules/@types"));
            if (directory === resolve(context.repositoryRoot)) break;
            directory = dirname(directory);
          }
          const typeNames = options.types ?? [
            ...new Set(
              typeRoots.flatMap((root) =>
                dependencies
                  .directoryEntries(root)
                  .filter(
                    (e) => e.type === "directory" && !e.name.startsWith("."),
                  )
                  .map((e) => e.name),
              ),
            ),
          ];
          const prepared = { ...options, typeRoots };
          const pending = project.sourcePaths.map((path) =>
            resolve(inspection.snapshotRoot, path),
          );
          const seen = new Set<string>();
          const push = (path: string) => {
            if (!seen.has(path)) pending.push(path);
          };
          const library = (fileName: string) => {
            if (!/^lib\.[a-z0-9.]+\.d\.ts$/u.test(fileName)) return undefined;
            const name = fileName.slice(4, -5);
            let directory = resolve(
              context.repositoryRoot,
              dirname(project.configPath),
            );
            while (within(context.repositoryRoot, directory)) {
              if (
                dependencies.fileExists(
                  resolve(
                    directory,
                    "node_modules",
                    `@typescript/lib-${name.split(".")[0]}`,
                    "package.json",
                  ),
                )
              )
                return undefined;
              if (directory === resolve(context.repositoryRoot)) break;
              directory = dirname(directory);
            }
            const file = resolve(libraryRoot, fileName);
            return dependencies.fileExists(file) ? file : undefined;
          };
          if (!options.noLib)
            for (const name of options.lib ?? [
              ts.getDefaultLibFileName(options),
            ]) {
              const file = library(name);
              if (!file) return unknown;
              push(file);
            }
          for (const name of typeNames) {
            const resolved = ts.resolveTypeReferenceDirective(
              name,
              resolve(context.repositoryRoot, project.configPath),
              prepared,
              host,
            ).resolvedTypeReferenceDirective;
            if (!resolved?.resolvedFileName) return unknown;
            push(resolved.resolvedFileName);
          }
          const resolveOne = (
            specifier: string,
            from: string,
            mode: Typescript.ResolutionMode,
          ) => {
            if (
              builtinModules.includes(specifier) ||
              builtinModules.includes(specifier.replace(/^node:/u, ""))
            ) {
              return ts.resolveTypeReferenceDirective(
                "node",
                resolve(context.repositoryRoot, project.configPath),
                prepared,
                host,
              ).resolvedTypeReferenceDirective?.resolvedFileName;
            }
            if (
              specifier.includes("\\") ||
              /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier) ||
              isAbsolute(specifier)
            )
              return undefined;
            const local = ts.resolveModuleName(
              specifier,
              from,
              prepared,
              inventory.has(from) ? snapshotHost : host,
              undefined,
              undefined,
              mode,
            ).resolvedModule;
            if (local !== undefined) return local.resolvedFileName;
            if (specifier.startsWith(".")) return undefined;
            const relativeContaining = within(inspection.snapshotRoot, from)
              ? relative(inspection.snapshotRoot, from)
              : undefined;
            const synthetic =
              relativeContaining === undefined
                ? from
                : resolve(context.repositoryRoot, relativeContaining);
            const installed = ts.resolveModuleName(
              specifier,
              synthetic,
              prepared,
              host,
              undefined,
              undefined,
              mode,
            ).resolvedModule;
            return installed !== undefined &&
              dependencies.packageFileExists(installed.resolvedFileName)
              ? installed.resolvedFileName
              : undefined;
          };
          const resolveModule = (specifier: string, from: string) => {
            const imports = resolveOne(specifier, from, ts.ModuleKind.ESNext);
            const requires = resolveOne(
              specifier,
              from,
              ts.ModuleKind.CommonJS,
            );
            return imports !== undefined && requires !== undefined
              ? [...new Set([imports, requires])]
              : undefined;
          };
          while (pending.length) {
            context.signal?.throwIfAborted();
            const path = resolve(pending.pop()!);
            if (seen.has(path)) continue;
            seen.add(path);
            if (seen.size % 16 === 0)
              await yieldTurn(
                undefined,
                context.signal === undefined
                  ? undefined
                  : { signal: context.signal },
              );
            const local = inventory.has(path);
            if (within(libraryRoot, path)) {
              if (librarySeen.has(path)) continue;
              librarySeen.add(path);
            }
            if (local && !allowed.has(path))
              return { independent: false, reason: "dependency" };
            if (!local && !/\.d\.[cm]?ts$/iu.test(path)) return unknown;
            const source = local
              ? texts.get(path)
              : dependencies.readFile(path);
            if (source === undefined) return unknown;
            const pre = ts.preProcessFile(source, true, true);
            edges +=
              pre.importedFiles.length * 2 +
              pre.referencedFiles.length +
              pre.typeReferenceDirectives.length +
              pre.libReferenceDirectives.length;
            if (edges > 4096) return { independent: false, reason: "limit" };
            const tree = ts.createSourceFile(
              path,
              source,
              ts.ScriptTarget.Latest,
              true,
              path.endsWith("x") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
            );
            // Nonliteral module loaders and shadowed require are not a closed graph.
            let unsafe = false;
            const visit = (node: Typescript.Node) => {
              if (
                !/\.d\.[cm]?ts$/iu.test(path) &&
                ts.isIdentifier(node) &&
                node.text === "require" &&
                !(
                  ts.isCallExpression(node.parent) &&
                  node.parent.expression === node &&
                  node.parent.arguments.length === 1 &&
                  ts.isStringLiteralLike(node.parent.arguments[0]!)
                )
              )
                unsafe = true;
              if (
                ts.isCallExpression(node) &&
                (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
                  (ts.isIdentifier(node.expression) &&
                    node.expression.text === "require")) &&
                (node.arguments.length !== 1 ||
                  !ts.isStringLiteralLike(node.arguments[0]!))
              )
                unsafe = true;
              if (
                ts.isMetaProperty(node) &&
                node.keywordToken === ts.SyntaxKind.ImportKeyword
              )
                unsafe = true;
              if (!unsafe) ts.forEachChild(node, visit);
            };
            visit(tree);
            if (unsafe) return unknown;
            for (const item of pre.importedFiles) {
              const resolved = resolveModule(item.fileName, path);
              if (!resolved) return unknown;
              for (const path of resolved) push(path);
            }
            for (const item of pre.referencedFiles) {
              const target = resolve(dirname(path), item.fileName);
              if (
                local
                  ? !inventory.has(target)
                  : !dependencies.packageFileExists(target)
              )
                return unknown;
              push(target);
            }
            for (const item of pre.typeReferenceDirectives) {
              const found = ts.resolveTypeReferenceDirective(
                item.fileName,
                path,
                prepared,
                host,
              ).resolvedTypeReferenceDirective;
              if (!found?.resolvedFileName) return unknown;
              push(found.resolvedFileName);
            }
            for (const reference of pre.libReferenceDirectives) {
              const name = reference.fileName.toLowerCase();
              if (!/^[a-z0-9.]+$/u.test(name)) return unknown;
              const file = library(`lib.${name}.d.ts`);
              if (!file) return unknown;
              push(file);
            }
            if (
              local &&
              /x$/u.test(path) &&
              (options.jsx === ts.JsxEmit.ReactJSX ||
                options.jsx === ts.JsxEmit.ReactJSXDev)
            ) {
              const runtime = resolveModule(
                `${options.jsxImportSource ?? "react"}/${options.jsx === ts.JsxEmit.ReactJSXDev ? "jsx-dev-runtime" : "jsx-runtime"}`,
                path,
              );
              if (!runtime) return unknown;
              for (const path of runtime) push(path);
            }
          }
        }
        signatures.push(signature);
      }
      if (
        signatures[0]!.size !== signatures[1]!.size ||
        [...signatures[0]!].some(
          ([path, digest]) => signatures[1]!.get(path) !== digest,
        )
      )
        return { independent: false, reason: "changed-input" };
      const manifest = dependencies.manifest();
      if (!manifest || !dependencies.validate(manifest)) return unknown;
      const record: ProofRecord = {
        key: key ?? "",
        manifest,
        context: dependencyContext,
        witnesses,
      };
      if (!(await valid(record, context.signal))) return unknown;
      if (owner !== undefined && key !== undefined) {
        const bytes = JSON.stringify(record).length * 2;
        if (owner.records.size >= 256 || owner.bytes + bytes > 32 * 1024 * 1024)
          return { independent: false, reason: "limit" };
        owner.records.set(key, record);
        owner.bytes += bytes;
      }
      return { independent: true, reason: "disjoint-inputs" };
    } catch {
      context.signal?.throwIfAborted();
      return unknown;
    }
  });
}
