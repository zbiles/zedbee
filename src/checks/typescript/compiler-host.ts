import { filterCapturedCompilerFiles } from "./captured-directory.js";
import {
  dependencyResolutionContainingFile,
  physicalWorkspaceRelativePath,
  type WorkspaceDirectoryAlias,
} from "./dependency-resolution-path.js";
import { rememberConfiguredTypes } from "./compiler-options-provenance.js";
import { CapturedDependencies } from "../../cache/captured-dependencies.js";
import {
  isContainedPath,
  normalizeRepositoryPath,
} from "../../inspection/read-json.js";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import {
  URL_SCHEME,
  WINDOWS_PATH as WINDOWS_DRIVE_PATH,
} from "../project/import-specifier.js";
import { containedRelativeRequest } from "./config-requests.js";
import { analysisKey, analysisStore } from "../analysis-reuse.js";
import {
  captureAnalysisDependencies,
  compilerPrograms,
  isRetainedCompilerCapture,
} from "./reuse-inputs.js";

export type CompilerProgramPurpose = "types" | "lint" | "standalone";

export interface SnapshotProgramInput {
  readonly reusePurpose?: CompilerProgramPurpose;
  readonly repositoryRoot: string;
  readonly snapshotRoot?: string;
  readonly workspaceAlias?: WorkspaceDirectoryAlias;
  readonly files: Readonly<Record<string, string>>;
  readonly rootNames: readonly string[];
  readonly options: ts.CompilerOptions;
  readonly projectReferences?: readonly ts.ProjectReference[];
  readonly dependencies?: CapturedDependencies;
}

export interface SnapshotProgram {
  readonly program: ts.Program;
  readonly programs: readonly ts.Program[];
  readonly localReads: readonly string[];
  readonly packageReads: readonly string[];
  readonly writes: readonly string[];
}

function directoryKey(path: string): string {
  // Match path.relative's case-insensitive containment on Windows.
  return sep === "\\" ? path.toLowerCase() : path;
}

function repositoryPath(
  snapshotRoot: string,
  path: string,
): string | undefined {
  const absolute = resolve(path);
  if (!isContainedPath(snapshotRoot, absolute)) return undefined;
  const result = normalizeRepositoryPath(relative(snapshotRoot, absolute));
  return result.length === 0 ? "." : result;
}

function isBareSpecifier(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !WINDOWS_DRIVE_PATH.test(specifier) &&
    !URL_SCHEME.test(specifier)
  );
}

function validateProjectSpecifier(sourcePath: string, specifier: string): void {
  if (isBareSpecifier(specifier)) return;
  if (
    containedRelativeRequest(normalizeRepositoryPath(sourcePath), specifier) ===
    undefined
  ) {
    throw new TypeError("Unsafe TypeScript module path");
  }
}

export function createSnapshotProgram(
  input: SnapshotProgramInput,
): SnapshotProgram {
  const dependencies =
    input.dependencies ??
    captureAnalysisDependencies({ repositoryRoot: input.repositoryRoot });
  const store = isRetainedCompilerCapture(dependencies)
    ? analysisStore<{
        result: SnapshotProgram;
        dependencies: CapturedDependencies;
      }>(compilerPrograms)
    : undefined;
  const key =
    store === undefined
      ? undefined
      : analysisKey({ ...input, dependencies: undefined });
  if (key !== undefined) {
    const previous = store!.get(key);
    const manifest = dependencies.manifest();
    if (
      previous?.dependencies === dependencies &&
      manifest !== undefined &&
      dependencies.validate(manifest)
    )
      return previous.result;
  }
  const result = createFreshSnapshotProgram({ ...input, dependencies });
  if (key !== undefined && dependencies.manifest() !== undefined) {
    const estimatedBytes = result.programs.reduce(
      (bytes, program) =>
        bytes +
        program
          .getSourceFiles()
          .reduce((size, source) => size + source.text.length * 32 + 4096, 0),
      0,
    );
    store!.set(key, { result, dependencies }, estimatedBytes);
  }
  return result;
}

function createFreshSnapshotProgram(
  input: SnapshotProgramInput,
): SnapshotProgram {
  const repositoryRoot = resolve(input.repositoryRoot);
  const snapshotRoot = resolve(input.snapshotRoot ?? repositoryRoot);
  const packageRoot = resolve(repositoryRoot, "node_modules");
  const dependencies =
    input.dependencies ?? new CapturedDependencies({ repositoryRoot });
  const files = new Map(
    Object.entries(input.files).map(([path, source]) => [
      resolve(snapshotRoot, ...normalizeRepositoryPath(path).split("/")),
      source,
    ]),
  );
  const snapshotDirectories = new Set<string>();
  for (const file of files.keys()) {
    // Include the file itself: the original containment check accepted equality.
    let directory = directoryKey(file);
    while (!snapshotDirectories.has(directory)) {
      snapshotDirectories.add(directory);
      const parent = dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
  }
  for (const [path, source] of Object.entries(input.files)) {
    const preprocessed = ts.preProcessFile(source, true, true);
    for (const reference of preprocessed.importedFiles) {
      validateProjectSpecifier(path, reference.fileName);
    }
    for (const reference of preprocessed.referencedFiles) {
      validateProjectSpecifier(path, reference.fileName);
    }
  }
  const localReads = new Set<string>();
  const packageReads = new Set<string>();
  const writes: string[] = [];
  const options: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    ...input.options,
    noEmit: true,
    incremental: false,
    composite: false,
  };
  const typescriptLibraryRoot = dirname(ts.getDefaultLibFilePath(options));
  // A materialized snapshot is represented by the captured input map. A
  // speculative alias lookup (including a Node builtin such as node:events)
  // is an inventory miss, not a lookup in the live installation.
  const isSnapshotPath = (candidate: string): boolean =>
    snapshotRoot !== repositoryRoot && isContainedPath(snapshotRoot, candidate);
  const dependencyFileAllowed = (candidate: string): boolean =>
    !isSnapshotPath(candidate) && dependencies.fileExists(candidate);
  const prepareProjectOptions = (
    projectOptions: ts.CompilerOptions,
    projectRootNames: readonly string[],
    discoverTypes = false,
  ): ts.CompilerOptions => {
    const prepared: ts.CompilerOptions = {
      ...projectOptions,
      noEmit: true,
      incremental: false,
      composite: false,
    };
    delete prepared.tsBuildInfoFile;
    if (prepared.typeRoots !== undefined) {
      prepared.typeRoots = prepared.typeRoots.map((typeRoot) => {
        const path = repositoryPath(snapshotRoot, typeRoot);
        // Custom declarations remain in the snapshot; only installed type roots
        // use the project's dependency directory.
        return path?.split("/").includes("node_modules")
          ? resolve(
              repositoryRoot,
              physicalWorkspaceRelativePath(path, input.workspaceAlias),
            )
          : typeRoot;
      });
    } else {
      const projectDirectory = dirname(
        typeof prepared.configFilePath === "string"
          ? prepared.configFilePath
          : resolve(snapshotRoot, projectRootNames[0] ?? "index.ts"),
      );
      const projectPath = repositoryPath(snapshotRoot, projectDirectory) ?? ".";
      let directory = resolve(
        repositoryRoot,
        physicalWorkspaceRelativePath(projectPath, input.workspaceAlias),
      );
      prepared.typeRoots = [];
      while (isContainedPath(repositoryRoot, directory)) {
        prepared.typeRoots.push(resolve(directory, "node_modules/@types"));
        if (directory === repositoryRoot) break;
        directory = dirname(directory);
      }
      // Preserve the entry project's implicit type discovery. Referenced
      // projects retain their compiler's default when types is omitted.
      if (discoverTypes && prepared.types === undefined)
        prepared.types = [
          ...new Set(
            prepared.typeRoots.flatMap((typeRoot) =>
              dependencies
                .directoryEntries(typeRoot)
                .filter(
                  (entry) =>
                    entry.type === "directory" && !entry.name.startsWith("."),
                )
                .map((entry) => entry.name),
            ),
          ),
        ].sort();
    }
    rememberConfiguredTypes(prepared, projectOptions.types);
    return prepared;
  };

  const createHost = (projectOptions: ts.CompilerOptions): ts.CompilerHost => {
    const configDirectory =
      typeof projectOptions.configFilePath === "string"
        ? dirname(resolve(snapshotRoot, projectOptions.configFilePath))
        : snapshotRoot;
    // TS's diagnostic module-specifier generation probes paths relative to its
    // alias base (including pathsBasePath inherited from another config).
    // Keep this context per program: referenced projects can use different bases.
    const pathsBasePath = projectOptions.pathsBasePath;
    const lookupDirectory = resolve(
      configDirectory,
      projectOptions.baseUrl ??
        (projectOptions.paths !== undefined && typeof pathsBasePath === "string"
          ? pathsBasePath
          : configDirectory),
    );
    const absolutePath = (path: string): string =>
      resolve(lookupDirectory, path);
    const defaultHost = ts.createCompilerHost(projectOptions, true);
    const moduleHost: ts.ModuleResolutionHost = {
      fileExists: (path) => {
        const absolute = absolutePath(path);
        return files.has(absolute) || dependencyFileAllowed(absolute);
      },
      readFile: (path) => {
        const absolute = absolutePath(path);
        const local = files.get(absolute);
        if (local !== undefined) return local;
        return dependencyFileAllowed(absolute)
          ? dependencies.readFile(absolute)
          : undefined;
      },
      directoryExists: (path) => {
        const absolute = absolutePath(path);
        if (snapshotDirectories.has(directoryKey(absolute))) return true;
        if (isContainedPath(repositoryRoot, absolute)) return true;
        return (
          (isContainedPath(packageRoot, absolute) ||
            isContainedPath(typescriptLibraryRoot, absolute)) &&
          dependencies.directoryExists(absolute)
        );
      },
      getDirectories: (path) => {
        const absolute = absolutePath(path);
        return isContainedPath(repositoryRoot, absolute) ||
          isContainedPath(typescriptLibraryRoot, absolute)
          ? dependencies.getDirectories(absolute)
          : [];
      },
      realpath: (path) => {
        const absolute = absolutePath(path);
        return files.has(absolute) || isSnapshotPath(absolute)
          ? absolute
          : dependencies.realpath(absolute);
      },
    };

    // Resolve project aliases and relative imports in the captured tree first.
    // Installed packages are resolved separately from the original project path,
    // so a snapshot's temporary location cannot select a different installation.
    const snapshotModuleHost: ts.ModuleResolutionHost = {
      fileExists: (path) => files.has(absolutePath(path)),
      readFile: (path) => files.get(absolutePath(path)),
      directoryExists: (path) =>
        snapshotDirectories.has(directoryKey(absolutePath(path))),
      realpath: (path) => absolutePath(path),
    };

    const host: ts.CompilerHost = {
      ...defaultHost,
      getCurrentDirectory: () => lookupDirectory,
      fileExists: moduleHost.fileExists,
      readFile(path) {
        const absolute = absolutePath(path);
        const local = files.get(absolute);
        if (local !== undefined) {
          const relativePath = repositoryPath(snapshotRoot, absolute);
          if (relativePath !== undefined) localReads.add(relativePath);
          return local;
        }
        if (dependencyFileAllowed(absolute)) {
          packageReads.add(absolute);
          return dependencies.readFile(absolute);
        }
        return undefined;
      },
      getSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile) {
        const source = host.readFile(path);
        if (source === undefined) return undefined;
        return ts.createSourceFile(
          absolutePath(path),
          source,
          languageVersion,
          true,
        );
      },
      directoryExists: (path) => moduleHost.directoryExists?.(path) ?? false,
      getDirectories: (path) => moduleHost.getDirectories?.(path) ?? [],
      realpath: (path) => moduleHost.realpath?.(path) ?? path,
      readDirectory(rootDir, extensions, excludes, includes, depth) {
        return filterCapturedCompilerFiles(
          files.keys(),
          absolutePath(rootDir),
          extensions,
          excludes,
          includes,
          depth,
        );
      },
      writeFile(path) {
        writes.push(path);
      },
      resolveModuleNameLiterals(
        moduleLiterals,
        containingFile,
        redirectedReference,
        resolutionOptions,
        containingSourceFile,
      ) {
        return moduleLiterals.map((literal) => {
          const specifier = literal.text;
          const mode = ts.getModeForUsageLocation(
            containingSourceFile,
            literal,
            resolutionOptions,
          );
          const localResolution = ts.resolveModuleName(
            specifier,
            containingFile,
            resolutionOptions,
            files.has(absolutePath(containingFile))
              ? snapshotModuleHost
              : moduleHost,
            undefined,
            redirectedReference,
            mode,
          );
          if (localResolution.resolvedModule !== undefined)
            return localResolution;
          if (!isBareSpecifier(specifier)) return localResolution;
          const syntheticContaining = dependencyResolutionContainingFile(
            repositoryRoot,
            snapshotRoot,
            containingFile,
            input.workspaceAlias,
          );
          const resolved = ts.resolveModuleName(
            specifier,
            syntheticContaining,
            resolutionOptions,
            moduleHost,
            undefined,
            redirectedReference,
            mode,
          );
          if (
            resolved.resolvedModule === undefined ||
            !dependencies.packageFileExists(
              resolve(resolved.resolvedModule.resolvedFileName),
            )
          ) {
            return { resolvedModule: undefined };
          }
          return resolved;
        });
      },
    };
    return host;
  };

  const rootNames = input.rootNames.map((path) => {
    const normalizedPath = normalizeRepositoryPath(path);
    if (
      normalizedPath.length === 0 ||
      normalizedPath.includes("\\") ||
      normalizedPath.split("/").includes("..") ||
      isAbsolute(normalizedPath) ||
      WINDOWS_DRIVE_PATH.test(normalizedPath)
    ) {
      throw new TypeError("Unsafe TypeScript source path");
    }
    const absolute = resolve(snapshotRoot, ...normalizedPath.split("/"));
    if (!files.has(absolute)) {
      throw new TypeError("Unavailable TypeScript source path");
    }
    return absolute;
  });
  const preparedOptions = prepareProjectOptions(options, rootNames, true);
  const program = ts.createProgram({
    rootNames,
    options: preparedOptions,
    host: createHost(preparedOptions),
    ...(input.projectReferences === undefined
      ? {}
      : { projectReferences: [...input.projectReferences] }),
  });
  const programs: ts.Program[] = [program];
  const visitedReferences = new Set<string>();
  const addReferencedPrograms = (
    references:
      readonly (ts.ResolvedProjectReference | undefined)[] | undefined,
  ): void => {
    for (const reference of references ?? []) {
      if (reference === undefined) continue;
      const configPath = reference.sourceFile.fileName;
      if (visitedReferences.has(configPath)) continue;
      visitedReferences.add(configPath);
      const referencedOptions = prepareProjectOptions(
        reference.commandLine.options,
        reference.commandLine.fileNames,
      );
      const referencedProgram = ts.createProgram({
        rootNames: reference.commandLine.fileNames,
        options: referencedOptions,
        host: createHost(referencedOptions),
        ...(reference.commandLine.projectReferences === undefined
          ? {}
          : { projectReferences: reference.commandLine.projectReferences }),
      });
      programs.push(referencedProgram);
      addReferencedPrograms(referencedProgram.getResolvedProjectReferences());
    }
  };
  addReferencedPrograms(program.getResolvedProjectReferences());
  return {
    program,
    programs: Object.freeze(programs),
    localReads: Object.freeze([...localReads].sort()),
    packageReads: Object.freeze([...packageReads].sort()),
    writes: Object.freeze(writes),
  };
}
