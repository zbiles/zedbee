import {
  acquireCompilerProof,
  compilerProofSlot,
  proofDigest,
  readProofInput,
  validCompilerProof,
  type ProofRecord,
  type Witness,
} from "./compiler-scope-witnesses.js";
export {
  releaseCompilerScopeProofs,
  validateCompilerScopeProofs,
} from "./compiler-scope-witnesses.js";
import { dependencyResolutionContainingFile } from "./dependency-resolution-path.js";
import { setImmediate as yieldTurn } from "node:timers/promises";
import { isBuiltin } from "node:module";
import { dirname, resolve, relative, sep, isAbsolute } from "node:path";
import type * as Typescript from "typescript";
import type { InspectionContext } from "../adapter.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../../inspection/types.js";
import { CapturedDependencies } from "../../cache/captured-dependencies.js";
import { captureSnapshotRegistry } from "../../inspection/snapshot-registry.js";
import { classifyCompilerChanges } from "../compiler-change-inputs.js";
import { loadCompilerScopeInputs } from "./compiler-scope-inputs.js";
export interface WorkspaceIndependenceProof {
  readonly independent: boolean;
  readonly reason:
    "disjoint-inputs" | "changed-input" | "dependency" | "unknown" | "limit";
}
class ProofLimit extends Error {}
class SnapshotLookup extends Error {
  constructor(readonly path: string) {
    super("Uninventoried resolution input");
  }
}
const unknown: WorkspaceIndependenceProof = {
  independent: false,
  reason: "unknown",
};
function isPackageSpecifier(specifier: string): boolean {
  return (
    /^(?:@[\w.-]+\/)?[\w-][\w./-]*$/u.test(specifier) &&
    specifier.split("/").every((part) => part && part !== "." && part !== "..")
  );
}
function within(root: string, path: string) {
  const part = relative(root, path);
  return (
    part === "" ||
    (!isAbsolute(part) && part !== ".." && !part.startsWith(`..${sep}`))
  );
}
async function captureWorkspaceSignature(
  inspection: RepositoryInspection,
  workspace: WorkspaceInspection,
  context: InspectionContext,
  state: {
    changes: Awaited<ReturnType<typeof classifyCompilerChanges>>;
    separateInstall: boolean;
    changedPaths: readonly string[];
    dependencies: CapturedDependencies;
    captured: <T>(operation: () => T) => T;
    witnesses: Witness[];
    charge: (count?: number) => void;
    librarySeen: Set<string>;
    ts: typeof Typescript;
  },
): Promise<Map<string, string> | WorkspaceIndependenceProof> {
  const {
    changes,
    separateInstall,
    changedPaths,
    dependencies,
    captured,
    witnesses,
    charge,
    librarySeen,
    ts,
  } = state;
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
    const text = await readProofInput(
      inspection.snapshotRoot,
      path,
      Math.min(limit, remaining),
      context.signal,
    );
    textBytes += text.length * 2;
    texts.set(resolve(inspection.snapshotRoot, path), text);
    if (!changes.localNpmInputs.has(path))
      signature.set(path, proofDigest(text));
    witnesses.push({
      root: inspection.snapshotRoot,
      path,
      digest: proofDigest(text),
      limit,
    });
    return text;
  };
  for (const path of inputs.inputPaths)
    await add(path, side.sourceFiles.includes(path) ? 1024 * 1024 : 64 * 1024);
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
  if (separateInstall) {
    const roots = new Set([
      side.relativeRoot,
      ...changedPaths.map((path) => path.split("/")[0]!),
    ]);
    for (const root of roots) {
      if (!changes.separateNpmRoots.has(root)) return unknown;
      const packageText = texts.get(
        resolve(inspection.snapshotRoot, root, "package.json"),
      );
      const packageManifest = JSON.parse(packageText ?? "null");
      if (packageManifest === null || packageManifest.workspaces !== undefined)
        return unknown;
      const lock = JSON.parse(
        await add(`${root}/package-lock.json`, 2 * 1024 * 1024),
      );
      if (
        !lock?.packages ||
        ![2, 3].includes(lock.lockfileVersion) ||
        Array.isArray(lock.packages) ||
        typeof lock.packages !== "object"
      )
        return unknown;
      for (const [path, entry] of Object.entries(lock.packages)) {
        if (
          path !== "" &&
          (!path.startsWith("node_modules/") ||
            path.includes("\\") ||
            path.split("/").some((part) => part === ".." || part === "."))
        )
          return unknown;
        if (
          typeof entry !== "object" ||
          entry === null ||
          ("link" in entry && entry.link === true) ||
          ("resolved" in entry &&
            typeof entry.resolved === "string" &&
            /^(?:file:|link:|workspace:|[.\/])/iu.test(entry.resolved))
        )
          return unknown;
      }
    }
  }
  // TypeScript may prefer a nested directory's package.json to index.ts.
  // Inventory its possible presence before treating index files as a closed
  // graph. Unsupported nested manifests retain full analyzer coverage.
  const manifests = new Set<string>();
  for (const path of inventory) {
    let directory = dirname(path);
    while (within(inspection.snapshotRoot, directory)) {
      manifests.add(
        relative(inspection.snapshotRoot, resolve(directory, "package.json"))
          .split(sep)
          .join("/"),
      );
      if (manifests.size > 4096) throw new ProofLimit();
      if (directory === inspection.snapshotRoot) break;
      directory = dirname(directory);
    }
  }
  const knownManifests = new Set(
    inspection.workspaces.map((w) => w.manifestPath),
  );
  const absentPaths = new Set<string>();
  for (const path of manifests) {
    if (knownManifests.has(path)) continue;
    context.signal?.throwIfAborted();
    const registry = await captureSnapshotRegistry(inspection.snapshotRoot, [
      path,
    ]);
    if (
      registry.resolve(path) !== undefined ||
      registry.entries().some((e) => e.kind === "symlink")
    )
      return unknown;
    witnesses.push({
      root: inspection.snapshotRoot,
      path,
      limit: 64 * 1024,
    });
    absentPaths.add(resolve(inspection.snapshotRoot, path));
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
  const snapshotFile = (path: string): boolean | undefined => {
    const absolute = resolve(path);
    if (inventory.has(absolute)) return true;
    if (
      !within(inspection.snapshotRoot, absolute) ||
      relative(inspection.snapshotRoot, absolute)
        .split(sep)
        .includes("node_modules")
    )
      return undefined;
    if (!absentPaths.has(absolute)) throw new SnapshotLookup(absolute);
    return false;
  };
  const snapshotDirectory = (path: string): boolean | undefined => {
    const absolute = resolve(path);
    if (directories.has(absolute)) return true;
    if (absentPaths.has(absolute)) return false;
    if (
      within(inspection.snapshotRoot, absolute) &&
      !relative(inspection.snapshotRoot, absolute)
        .split(sep)
        .includes("node_modules")
    )
      throw new SnapshotLookup(absolute);
    return undefined;
  };
  const snapshotRead = (path: string) => {
    if (
      changes.localNpmInputs.has(
        relative(inspection.snapshotRoot, resolve(path)).split(sep).join("/"),
      )
    )
      throw Error("Resolution uses a changed package manifest");
    snapshotFile(path);
    return texts.get(resolve(path));
  };
  const resolveSnapshotMetadata = async <T>(operation: () => T): Promise<T> => {
    for (;;) {
      context.signal?.throwIfAborted();
      try {
        return operation();
      } catch (error) {
        if (!(error instanceof SnapshotLookup)) throw error;
        charge();
        const path = relative(inspection.snapshotRoot, error.path)
          .split(sep)
          .join("/");
        const registry = await captureSnapshotRegistry(
          inspection.snapshotRoot,
          [path],
        );
        context.signal?.throwIfAborted();
        if (registry.entries().some((e) => e.kind === "symlink"))
          throw Error("Unsupported resolution alias");
        const entry = registry.resolve(path);
        if (entry?.targetKind === "file")
          throw Error("Unsupported resolution metadata");
        if (entry?.targetKind === "directory") {
          directories.add(error.path);
          witnesses.push({
            root: inspection.snapshotRoot,
            path,
            limit: 0,
            directory: true,
          });
        } else {
          absentPaths.add(error.path);
          witnesses.push({
            root: inspection.snapshotRoot,
            path,
            limit: 0,
          });
        }
      }
    }
  };
  const snapshotHost: Typescript.ModuleResolutionHost = {
    fileExists: (path) => snapshotFile(path) ?? false,
    readFile: snapshotRead,
    directoryExists: (path) => snapshotDirectory(path) ?? false,
    realpath: (path) => resolve(path),
  };
  const libraryRoot = dirname(ts.getDefaultLibFilePath({}));
  const dependencyPath = (path: string) =>
    within(context.repositoryRoot, resolve(path)) ||
    within(libraryRoot, resolve(path));
  const host: Typescript.ModuleResolutionHost = {
    fileExists: (path) =>
      snapshotFile(path) ??
      (dependencyPath(path) && captured(() => dependencies.fileExists(path))),
    readFile: (path) =>
      snapshotRead(path) ??
      (dependencyPath(path)
        ? captured(() => dependencies.readCapturedFile(path))
        : undefined),
    directoryExists: (path) =>
      snapshotDirectory(path) ??
      (within(context.repositoryRoot, resolve(path)) ||
        (within(libraryRoot, resolve(path)) &&
          captured(() => dependencies.directoryExists(path)))),
    getDirectories: (path) =>
      dependencyPath(path)
        ? captured(() => dependencies.getDirectories(path))
        : [],
    realpath: (path) =>
      inventory.has(resolve(path))
        ? resolve(path)
        : captured(() => dependencies.realpath(path)),
  };
  // Separately locked projects can prove their captured graph disjoint
  // even if a package is absent. Shared installation layouts still
  // require positive witnesses for all declared packages.
  for (const w of separateInstall
    ? []
    : inspection.workspaces.filter(
        (w) =>
          w.relativeRoot === "." ||
          w.relativeRoot === side.relativeRoot ||
          side.relativeRoot.startsWith(`${w.relativeRoot}/`),
      ))
    for (const declaration of w.dependencyDeclarations) {
      let directory = resolve(context.repositoryRoot, side.relativeRoot),
        found = false;
      while (within(context.repositoryRoot, directory)) {
        charge();
        if (
          captured(() =>
            dependencies.fileExists(
              resolve(
                directory,
                "node_modules",
                declaration.name,
                "package.json",
              ),
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
        const text = texts.get(resolve(inspection.snapshotRoot, sourcePath))!;
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
      // Static source closure still needs the normal library witnesses.
    }
    if (
      options.plugins !== undefined ||
      options.moduleSuffixes ||
      options.rootDirs ||
      options.noResolve ||
      options.typeRoots ||
      options.allowJs ||
      options.importHelpers
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
          captured(() => dependencies.directoryEntries(root))
            .filter((e) => e.type === "directory" && !e.name.startsWith("."))
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
      charge();
      if (!/^lib\.[a-z0-9.]+\.d\.ts$/u.test(fileName)) return undefined;
      const name = fileName.slice(4, -5);
      let directory = resolve(
        context.repositoryRoot,
        dirname(project.configPath),
      );
      while (within(context.repositoryRoot, directory)) {
        if (
          captured(() =>
            dependencies.fileExists(
              resolve(
                directory,
                "node_modules",
                `@typescript/lib-${name.split(".")[0]}`,
                "package.json",
              ),
            ),
          )
        )
          return undefined;
        if (directory === resolve(context.repositoryRoot)) break;
        directory = dirname(directory);
      }
      const file = resolve(libraryRoot, fileName);
      return captured(() => dependencies.fileExists(file))
        ? file
        : separateInstall
          ? false
          : undefined;
    };
    if (!options.noLib)
      for (const name of options.lib ?? [ts.getDefaultLibFileName(options)]) {
        const file = library(name);
        if (file === undefined) return unknown;
        if (file !== false) push(file);
      }
    for (const name of typeNames) {
      charge();
      const resolved = (
        await resolveSnapshotMetadata(() =>
          ts.resolveTypeReferenceDirective(
            name,
            resolve(context.repositoryRoot, project.configPath),
            prepared,
            host,
          ),
        )
      ).resolvedTypeReferenceDirective;
      if (!resolved?.resolvedFileName) {
        if (!separateInstall || !isPackageSpecifier(name)) return unknown;
      } else push(resolved.resolvedFileName);
    }
    const resolveOne = (
      specifier: string,
      from: string,
      mode: Typescript.ResolutionMode,
    ) => {
      charge();
      const builtin = isBuiltin(specifier);
      if (
        specifier.includes("\\") ||
        (!builtin && /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)) ||
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
      if (builtin) {
        charge();
        return ts.resolveTypeReferenceDirective(
          "node",
          resolve(context.repositoryRoot, project.configPath),
          prepared,
          host,
        ).resolvedTypeReferenceDirective?.resolvedFileName;
      }
      if (specifier.startsWith(".")) return undefined;
      const synthetic = dependencyResolutionContainingFile(
        context.repositoryRoot,
        inspection.snapshotRoot,
        from,
      );
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
        captured(() =>
          dependencies.packageFileExists(installed.resolvedFileName),
        )
        ? installed.resolvedFileName
        : undefined;
    };
    const resolveModule = async (specifier: string, from: string) => {
      const imports = await resolveSnapshotMetadata(() =>
        resolveOne(specifier, from, ts.ModuleKind.ESNext),
      );
      const requires = await resolveSnapshotMetadata(() =>
        resolveOne(specifier, from, ts.ModuleKind.CommonJS),
      );
      if (imports !== undefined && requires !== undefined)
        return [...new Set([imports, requires])];
      if (
        separateInstall &&
        imports === undefined &&
        requires === undefined &&
        (isBuiltin(specifier) || isPackageSpecifier(specifier))
      )
        return [];
      return undefined;
    };
    while (pending.length) {
      context.signal?.throwIfAborted();
      const path = resolve(pending.pop()!);
      if (seen.has(path)) continue;
      seen.add(path);
      if (seen.size % 16 === 0)
        await yieldTurn(
          undefined,
          context.signal === undefined ? undefined : { signal: context.signal },
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
        : captured(() => dependencies.readCapturedFile(path));
      if (source === undefined) return unknown;
      if (local && !separateInstall && /\.[cm]?jsx?$/iu.test(path))
        return unknown;
      if (local && /@jsx(?:ImportSource|Runtime|Frag)?\b/iu.test(source))
        return unknown;
      const pre = ts.preProcessFile(source, true, true);
      charge(
        pre.importedFiles.length * 2 +
          pre.referencedFiles.length +
          pre.typeReferenceDirectives.length +
          pre.libReferenceDirectives.length,
      );
      const tree = ts.createSourceFile(
        path,
        source,
        ts.ScriptTarget.Latest,
        true,
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
        const resolved = await resolveModule(item.fileName, path);
        if (!resolved) return unknown;
        for (const path of resolved) push(path);
      }
      for (const item of pre.referencedFiles) {
        const target = resolve(dirname(path), item.fileName);
        if (
          local
            ? !inventory.has(target)
            : !captured(() => dependencies.packageFileExists(target))
        )
          return unknown;
        push(target);
      }
      for (const item of pre.typeReferenceDirectives) {
        for (const mode of [
          ts.ModuleKind.ESNext,
          ts.ModuleKind.CommonJS,
        ] as const) {
          charge();
          const found = (
            await resolveSnapshotMetadata(() =>
              ts.resolveTypeReferenceDirective(
                item.fileName,
                path,
                prepared,
                host,
                undefined,
                undefined,
                mode,
              ),
            )
          ).resolvedTypeReferenceDirective;
          if (!found?.resolvedFileName) {
            if (!separateInstall || !isPackageSpecifier(item.fileName))
              return unknown;
          } else push(found.resolvedFileName);
        }
      }
      for (const reference of pre.libReferenceDirectives) {
        const name = reference.fileName.toLowerCase();
        if (!/^[a-z0-9.]+$/u.test(name)) return unknown;
        const file = library(`lib.${name}.d.ts`);
        if (file === undefined) return unknown;
        if (file !== false) push(file);
      }
      if (
        local &&
        (options.jsx === ts.JsxEmit.ReactJSX ||
          options.jsx === ts.JsxEmit.ReactJSXDev)
      ) {
        const runtime = await resolveModule(
          `${options.jsxImportSource ?? "react"}/${options.jsx === ts.JsxEmit.ReactJSXDev ? "jsx-dev-runtime" : "jsx-runtime"}`,
          path,
        );
        if (!runtime) return unknown;
        for (const path of runtime) push(path);
      }
    }
  }
  return signature;
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
  const separateInstall = changes.separateNpmRoots.has(workspace.relativeRoot);
  const changedPaths = [...changes.sourcePaths, ...changes.localNpmInputs];
  if (
    !changes.complete ||
    changes.requiresBroadComparison ||
    changedPaths.length === 0 ||
    (changes.localNpmInputs.size !== 0 && !separateInstall)
  )
    return unknown;
  const prefix =
    workspace.relativeRoot === "." ? "" : `${workspace.relativeRoot}/`;
  if (changedPaths.some((path) => path.startsWith(prefix)))
    return { independent: false, reason: "changed-input" };
  return acquireCompilerProof(context.signal, async () => {
    context.signal?.throwIfAborted();
    const slot = compilerProofSlot(context, workspace.relativeRoot);
    if (slot.previous !== undefined) {
      try {
        if (await validCompilerProof(slot.previous, context.signal))
          return { independent: true, reason: "disjoint-inputs" };
      } catch {
        context.signal?.throwIfAborted();
      }
      slot.invalidate(slot.previous);
    }
    try {
      const dependencyContext = { repositoryRoot: context.repositoryRoot };
      const dependencies = new CapturedDependencies(dependencyContext);
      const captured = <T>(operation: () => T): T => {
        if (dependencies.failure() !== undefined)
          throw Error("Incomplete proof capture");
        const value = operation();
        if (dependencies.failure() !== undefined)
          throw Error("Incomplete proof capture");
        return value;
      };
      const witnesses: Witness[] = [];
      const signatures: Map<string, string>[] = [];
      let edges = 0;
      const charge = (count = 1) => {
        edges += count;
        if (edges > 4096) throw new ProofLimit();
      };
      const librarySeen = new Set<string>();
      const ts = await import("typescript");
      for (const inspection of [
        context.baselineInspection,
        context.targetInspection,
      ]) {
        const signature = await captureWorkspaceSignature(
          inspection,
          workspace,
          context,
          {
            changes,
            separateInstall,
            changedPaths,
            dependencies,
            captured,
            witnesses,
            charge,
            librarySeen,
            ts,
          },
        );
        if (!(signature instanceof Map)) return signature;
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
      const changedInstallPrefixes = [...changes.localNpmInputs].map(
        (path) => `repository:${dirname(path)}/node_modules/`,
      );
      const changedSourceInstallPrefixes = [
        ...new Set(
          [...changes.sourcePaths].map(
            (path) => `repository:${path.split("/")[0]}/node_modules/`,
          ),
        ),
      ];
      if (
        separateInstall &&
        manifest.probes.some(
          (probe) =>
            (probe.kind === "entry" &&
              probe.entryType === "denied" &&
              probe.path.includes("node_modules/")) ||
            changedInstallPrefixes.some((prefix) =>
              probe.path.startsWith(prefix),
            ) ||
            (probe.kind === "file" &&
              [probe.path, probe.realPath].some((path) =>
                [
                  ...changedInstallPrefixes,
                  ...changedSourceInstallPrefixes,
                ].some((prefix) => path.startsWith(prefix)),
              )),
        )
      )
        return unknown;
      const record: ProofRecord = {
        key: slot.key,
        manifest,
        context: dependencyContext,
        witnesses,
      };
      if (!(await validCompilerProof(record, context.signal))) return unknown;
      if (!slot.retain(record)) return { independent: false, reason: "limit" };
      return { independent: true, reason: "disjoint-inputs" };
    } catch (error) {
      context.signal?.throwIfAborted();
      if (error instanceof ProofLimit)
        return { independent: false, reason: "limit" };
      return unknown;
    }
  });
}
