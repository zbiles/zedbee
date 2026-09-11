import { CapturedDependencies } from "../../cache/captured-dependencies.js";
import { dirname, isAbsolute, posix, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import picomatch from "picomatch";
import { analysisKey, analysisStore } from "../analysis-reuse.js";
import {
  captureAnalysisDependencies,
  compilerPrograms,
} from "./reuse-inputs.js";

export interface SnapshotProgramInput {
  readonly repositoryRoot: string;
  readonly snapshotRoot?: string;
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

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/u;

function normalized(path: string): string {
  return path.split(sep).join("/");
}

function contained(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return (
    fromRoot === "" ||
    (!isAbsolute(fromRoot) &&
      fromRoot !== ".." &&
      !fromRoot.startsWith(`..${sep}`))
  );
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
  if (!contained(snapshotRoot, absolute)) return undefined;
  const result = normalized(relative(snapshotRoot, absolute));
  return result.length === 0 ? "." : result;
}

function isBareSpecifier(specifier: string): boolean {
  if (specifier.startsWith("node:")) return true;
  return (
    !specifier.startsWith(".") &&
    !specifier.startsWith("/") &&
    !WINDOWS_DRIVE_PATH.test(specifier) &&
    !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier)
  );
}

function validateProjectSpecifier(sourcePath: string, specifier: string): void {
  if (isBareSpecifier(specifier)) return;
  if (
    specifier.includes("\\") ||
    WINDOWS_DRIVE_PATH.test(specifier) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(specifier) ||
    specifier.startsWith("/")
  ) {
    throw new TypeError("Unsafe TypeScript module path");
  }
  const candidate = posix.normalize(
    posix.join(posix.dirname(normalized(sourcePath)), specifier),
  );
  if (candidate === ".." || candidate.startsWith("../")) {
    throw new TypeError("Unsafe TypeScript module path");
  }
}

export function createSnapshotProgram(
  input: SnapshotProgramInput,
): SnapshotProgram {
  const dependencies =
    input.dependencies ??
    captureAnalysisDependencies({ repositoryRoot: input.repositoryRoot });
  const store = analysisStore<{
    result: SnapshotProgram;
    dependencies: CapturedDependencies;
  }>(compilerPrograms);
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
      resolve(snapshotRoot, ...normalized(path).split("/")),
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
  delete options.tsBuildInfoFile;
  const typescriptLibraryRoot = dirname(ts.getDefaultLibFilePath(options));
  const dependencyFileAllowed = (candidate: string): boolean =>
    dependencies.fileExists(candidate);
  if (options.typeRoots !== undefined) {
    options.typeRoots = options.typeRoots.map((typeRoot) => {
      const path = repositoryPath(snapshotRoot, typeRoot);
      // Custom declarations remain in the snapshot; only installed type roots
      // use the project's dependency directory.
      return path?.split("/").includes("node_modules")
        ? resolve(repositoryRoot, path)
        : typeRoot;
    });
  } else {
    const projectDirectory = dirname(
      typeof options.configFilePath === "string"
        ? options.configFilePath
        : resolve(snapshotRoot, input.rootNames[0] ?? "index.ts"),
    );
    const projectPath = repositoryPath(snapshotRoot, projectDirectory) ?? ".";
    let directory = resolve(repositoryRoot, projectPath);
    options.typeRoots = [];
    while (contained(repositoryRoot, directory)) {
      options.typeRoots.push(resolve(directory, "node_modules/@types"));
      if (directory === repositoryRoot) break;
      directory = dirname(directory);
    }
    if (options.types === undefined)
      options.types = [
        ...new Set(
          options.typeRoots.flatMap((typeRoot) =>
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

  const defaultHost = ts.createCompilerHost(options, true);
  const moduleHost: ts.ModuleResolutionHost = {
    fileExists: (path) => {
      const absolute = resolve(path);
      return files.has(absolute) || dependencyFileAllowed(absolute);
    },
    readFile: (path) => {
      const absolute = resolve(path);
      const local = files.get(absolute);
      if (local !== undefined) return local;
      return dependencyFileAllowed(absolute)
        ? dependencies.readFile(absolute)
        : undefined;
    },
    directoryExists: (path) => {
      const absolute = resolve(path);
      if (snapshotDirectories.has(directoryKey(absolute))) return true;
      if (contained(repositoryRoot, absolute)) return true;
      return (
        (contained(packageRoot, absolute) ||
          contained(typescriptLibraryRoot, absolute)) &&
        dependencies.directoryExists(absolute)
      );
    },
    getDirectories: (path) =>
      contained(repositoryRoot, resolve(path)) ||
      contained(typescriptLibraryRoot, resolve(path))
        ? dependencies.getDirectories(resolve(path))
        : [],
    realpath: (path) =>
      files.has(resolve(path)) ? resolve(path) : dependencies.realpath(path),
  };

  // Resolve project aliases and relative imports in the captured tree first.
  // Installed packages are resolved separately from the original project path,
  // so a snapshot's temporary location cannot select a different installation.
  const snapshotModuleHost: ts.ModuleResolutionHost = {
    fileExists: (path) => files.has(resolve(path)),
    readFile: (path) => files.get(resolve(path)),
    directoryExists: (path) =>
      snapshotDirectories.has(directoryKey(resolve(path))),
    realpath: (path) => resolve(path),
  };

  const host: ts.CompilerHost = {
    ...defaultHost,
    getCurrentDirectory: () => snapshotRoot,
    fileExists: moduleHost.fileExists,
    readFile(path) {
      const absolute = resolve(path);
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
        path,
        source,
        languageVersion,
        true,
        /\.tsx$/iu.test(path)
          ? ts.ScriptKind.TSX
          : /\.[cm]?js$/iu.test(path)
            ? ts.ScriptKind.JS
            : ts.ScriptKind.TS,
      );
    },
    directoryExists: (path) => moduleHost.directoryExists?.(path) ?? false,
    getDirectories: (path) => moduleHost.getDirectories?.(path) ?? [],
    realpath: (path) => moduleHost.realpath?.(path) ?? path,
    readDirectory(rootDir, extensions, excludes, includes, depth) {
      const root = resolve(rootDir);
      const includeMatchers = (includes.length > 0 ? includes : ["**/*"]).map(
        (pattern) => picomatch(pattern, { dot: true }),
      );
      const excludeMatchers = (excludes ?? []).map((pattern) =>
        picomatch(pattern, { dot: true }),
      );
      return [...files.keys()].filter((path) => {
        const fromRoot = normalized(relative(root, path));
        if (
          fromRoot === ".." ||
          fromRoot.startsWith("../") ||
          (depth !== undefined && fromRoot.split("/").length - 1 > depth) ||
          !extensions.some((extension) => path.endsWith(extension))
        ) {
          return false;
        }
        return (
          includeMatchers.some((match) => match(fromRoot)) &&
          !excludeMatchers.some((match) => match(fromRoot))
        );
      });
    },
    writeFile(path) {
      writes.push(path);
    },
    resolveModuleNames(moduleNames, containingFile) {
      return moduleNames.map((specifier) => {
        const localResolution = ts.resolveModuleName(
          specifier,
          containingFile,
          options,
          files.has(resolve(containingFile)) ? snapshotModuleHost : moduleHost,
        ).resolvedModule;
        if (localResolution !== undefined) return localResolution;
        if (!isBareSpecifier(specifier)) return undefined;
        const relativeContaining =
          repositoryPath(snapshotRoot, containingFile) ?? "src/index.ts";
        const syntheticContaining = resolve(
          repositoryRoot,
          ...relativeContaining.split("/"),
        );
        const resolved = ts.resolveModuleName(
          specifier,
          syntheticContaining,
          options,
          moduleHost,
        ).resolvedModule;
        if (
          resolved === undefined ||
          !dependencies.packageFileExists(resolve(resolved.resolvedFileName))
        ) {
          return undefined;
        }
        return resolved;
      });
    },
  };

  const rootNames = input.rootNames.map((path) => {
    const normalizedPath = normalized(path);
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
  const program = ts.createProgram({
    rootNames,
    options,
    host,
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
      const referencedOptions: ts.CompilerOptions = {
        ...reference.commandLine.options,
        noEmit: true,
        incremental: false,
        composite: false,
      };
      delete referencedOptions.tsBuildInfoFile;
      const referencedProgram = ts.createProgram({
        rootNames: reference.commandLine.fileNames,
        options: referencedOptions,
        host,
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
