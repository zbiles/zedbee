import { configuredTypesForProgram } from "./typescript/compiler-options-provenance.js";
import type * as ts from "typescript";
import type { DiagnosticMessagePolicy } from "../config/schema.js";
import { builtinModules, createRequire } from "node:module";
const typescriptVersion: string = createRequire(import.meta.url)(
  "typescript/package.json",
).version;
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { ZEDBEE_VERSION } from "../core/package-version.js";
import { CheckIncompleteError } from "./incomplete-error.js";
import type { CapturedDependencies } from "../cache/captured-dependencies.js";
import type {
  RepositoryInspection,
  WorkspaceInspection,
} from "../inspection/types.js";
export interface ComparisonContext {
  readonly version: 1;
  readonly status: "comparable" | "environment-incomplete" | "unverified";
  readonly reason:
    | "captured-inputs"
    | "required-installation-unavailable"
    | "inputs-changed"
    | "unsupported-inputs";
  readonly swarmVersion: string;
  readonly analyzerVersion: string;
  readonly analyzerRevision: "comparison-context-v1";
}
export function sanitizeComparisonContext(value: unknown): ComparisonContext {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TypeError("Invalid comparison context");
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).sort().join() !==
      [
        "version",
        "status",
        "reason",
        "swarmVersion",
        "analyzerVersion",
        "analyzerRevision",
      ]
        .sort()
        .join() ||
    v.version !== 1 ||
    v.analyzerRevision !== "comparison-context-v1" ||
    !["comparable", "environment-incomplete", "unverified"].includes(
      String(v.status),
    ) ||
    ![
      "captured-inputs",
      "required-installation-unavailable",
      "inputs-changed",
      "unsupported-inputs",
    ].includes(String(v.reason)) ||
    ![v.swarmVersion, v.analyzerVersion].every(
      (x) => typeof x === "string" && /^[0-9][0-9A-Za-z.+-]{0,127}$/u.test(x),
    )
  )
    throw new TypeError("Invalid comparison context");
  if (
    (v.status === "comparable") !== (v.reason === "captured-inputs") ||
    (v.status === "environment-incomplete") !==
      (v.reason === "required-installation-unavailable")
  )
    throw new TypeError("Invalid comparison evidence");
  return Object.freeze({ ...v }) as unknown as ComparisonContext;
}
export function comparisonContext(
  status: ComparisonContext["status"] = "comparable",
  reason: ComparisonContext["reason"] = "captured-inputs",
): ComparisonContext {
  return Object.freeze({
    version: 1,
    status,
    reason,
    swarmVersion: ZEDBEE_VERSION,
    analyzerVersion: typescriptVersion,
    analyzerRevision: "comparison-context-v1",
  });
}
function packageName(specifier: string): string | undefined {
  if (
    !/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+(?:\/[a-z0-9._/-]+)?$/iu.test(
      specifier,
    ) ||
    specifier.startsWith(".")
  )
    return undefined;
  return specifier.startsWith("@")
    ? specifier.split("/").slice(0, 2).join("/")
    : specifier.split("/")[0];
}
/** Only already-observed positive package witnesses can avoid installation-only
 * semantic work. Optional readiness must never spend mandatory capture capacity.
 * Missing, unused or unsupported declarations retain the original diagnostic path. */
function installationReady(
  declared: ReadonlySet<string>,
  repositoryRoot: string,
  workspace: WorkspaceInspection,
  dependencies: CapturedDependencies,
  programs: readonly ts.Program[],
  snapshotRoot: string,
): boolean {
  if (declared.size === 0) return true;
  if (
    declared.size > 500 ||
    resolve(repositoryRoot) !== resolve(dependencies.context.repositoryRoot)
  )
    return false;
  try {
    const manifest = dependencies.manifest();
    if (manifest === undefined) return false;
    const files = new Map(
      manifest.probes
        .filter((probe) => probe.kind === "file")
        .map((probe) => [probe.path, probe]),
    );
    const selected: import("../cache/dependency-inputs.js").DependencyProbe[] =
      [];
    for (const name of declared) {
      if (
        name.length > 214 ||
        packageName(name) !== name ||
        name.split("/").some((part) => part === "." || part === "..")
      )
        return false;
      let directory = resolve(repositoryRoot, workspace.relativeRoot),
        found = false;
      for (let depth = 0; depth < 64; depth++) {
        const part = relative(resolve(repositoryRoot), directory);
        if (isAbsolute(part) || part === ".." || part.startsWith(`..${sep}`))
          return false;
        const path = relative(
          resolve(repositoryRoot),
          join(directory, "node_modules", name, "package.json"),
        )
          .split(sep)
          .join("/");
        const witness =
          files.get(`repository:${path}`) ??
          (directory === resolve(repositoryRoot)
            ? files.get(`packages:${name}/package.json`)
            : undefined);
        if (witness !== undefined) {
          selected.push(witness);
          found = true;
          break;
        }
        if (directory === resolve(repositoryRoot)) break;
        directory = dirname(directory);
      }
      if (!found) return false;
    }
    const rootOnly = selected.every(
      (witness) =>
        witness.path.startsWith("packages:") ||
        witness.path.startsWith("repository:node_modules/"),
    );
    if (!rootOnly) {
      // A workspace-local installation says nothing about a sibling source imported
      // into its program. Keep the existing diagnostic path for those programs.
      for (const program of programs)
        for (const file of program.getSourceFiles()) {
          if (
            program.isSourceFileFromExternalLibrary(file) ||
            program.isSourceFileDefaultLibrary(file)
          )
            continue;
          const path = relative(
            resolve(snapshotRoot, workspace.relativeRoot),
            resolve(file.fileName),
          );
          if (isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`))
            return false;
        }
    }
    selected.sort((left, right) =>
      left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
    );
    return dependencies.validate({
      version: 1,
      roots: manifest.roots,
      probes: selected,
    });
  } catch {
    return false;
  }
}
/** An unresolved lookup alone does not prove a missing install. Require an
 * applicable declaration and captured absent package manifests. */
export async function assertRequiredInstallation(options: {
  programs: readonly ts.Program[];
  repositoryRoot: string;
  inspection: RepositoryInspection;
  workspace: WorkspaceInspection;
  dependencies: CapturedDependencies;
  side: "baseline" | "target";
  diagnosticMessages?: DiagnosticMessagePolicy;
}): Promise<void> {
  const { inspection, workspace, dependencies, repositoryRoot } = options;
  const declared = new Set(
    inspection.workspaces
      .filter(
        (w) =>
          w.relativeRoot === "." ||
          w.relativeRoot === workspace.relativeRoot ||
          workspace.relativeRoot.startsWith(`${w.relativeRoot}/`),
      )
      .flatMap((w) => w.dependencyDeclarations.map((d) => d.name)),
  );
  if (
    installationReady(
      declared,
      repositoryRoot,
      workspace,
      dependencies,
      options.programs,
      inspection.snapshotRoot,
    )
  )
    return;
  for (const program of options.programs)
    for (const diagnostic of [
      ...program.getOptionsDiagnostics(),
      ...program
        .getSourceFiles()
        .filter(
          (file) =>
            !program.isSourceFileFromExternalLibrary(file) &&
            !program.isSourceFileDefaultLibrary(file),
        )
        .flatMap((file) => program.getSemanticDiagnostics(file)),
    ]) {
      if (![2307, 2591, 2688, 2875, 7016].includes(diagnostic.code)) continue;
      const text =
        typeof diagnostic.messageText === "string"
          ? diagnostic.messageText
          : diagnostic.messageText.messageText;
      const specifier =
        /(?:module path|module|definition file for) '([^']+)'/u.exec(text)?.[1];
      const moduleName =
        diagnostic.code === 2591
          ? "@types/node"
          : specifier === undefined
            ? undefined
            : builtinModules.includes(specifier) ||
                builtinModules.includes(specifier.replace(/^node:/u, ""))
              ? "@types/node"
              : packageName(specifier);
      if (moduleName === undefined) continue;
      const configuredTypes = configuredTypesForProgram(program);
      if (
        moduleName === "@types/node" &&
        configuredTypes !== undefined &&
        !configuredTypes.includes("node") &&
        !configuredTypes.includes("@types/node")
      )
        continue;
      const typesName = moduleName.startsWith("@")
        ? `@types/${moduleName.slice(1).replace("/", "__")}`
        : `@types/${moduleName}`;
      const candidates = [
        moduleName,
        ...([2688, 7016].includes(diagnostic.code) ||
        (diagnostic.code === 2875 &&
          /\/jsx(?:-dev)?-runtime$/u.test(specifier!))
          ? [typesName]
          : []),
      ].filter((name) => declared.has(name));
      let unavailable: string | undefined;
      for (const name of candidates) {
        const sourcePath =
          diagnostic.file === undefined
            ? undefined
            : relative(inspection.snapshotRoot, diagnostic.file.fileName);
        const containedSource =
          sourcePath !== undefined &&
          !isAbsolute(sourcePath) &&
          sourcePath !== ".." &&
          !sourcePath.startsWith(`..${sep}`);
        let path = containedSource
          ? dirname(resolve(repositoryRoot, sourcePath!))
          : resolve(repositoryRoot, workspace.relativeRoot);
        let installed = false;
        const searched: string[] = [];
        for (;;) {
          const manifestPath = join(path, "node_modules", name, "package.json");
          searched.push(
            path === resolve(repositoryRoot)
              ? `packages:${name}/package.json`
              : `repository:${relative(resolve(repositoryRoot), manifestPath).split(sep).join("/")}`,
          );
          if (dependencies.fileExists(manifestPath)) {
            installed = true;
            break;
          }
          if (path === resolve(repositoryRoot)) break;
          const parent = dirname(path);
          if (parent === path) break;
          path = parent;
        }
        if (installed) continue;
        const manifest = dependencies.manifest();
        const relevant = manifest?.probes.filter((p) =>
          searched.includes(p.path),
        );
        if (
          relevant?.some((p) => p.kind === "entry" && p.entryType === "denied")
        )
          throw new CheckIncompleteError({
            code: "COMPARISON_INPUTS_UNVERIFIED",
            message:
              "Required package resolution crossed an unsupported or unreadable installation boundary.",
            remediation:
              "Verify the workspace installation and supported package layout, then rerun.",
          });
        const absent =
          relevant !== undefined &&
          searched.every((path) =>
            relevant.some((p) => p.path === path && p.kind === "missing"),
          );
        if (absent) {
          unavailable = name;
          break;
        }
      }
      if (unavailable === undefined) continue;
      const {
        reviewedInstallationLabels,
        INSTALLATION_MESSAGE,
        INSTALLATION_REMEDIATION,
      } = await import("./installation-diagnostic.js");
      const labels =
        options.diagnosticMessages === "source-free"
          ? undefined
          : await reviewedInstallationLabels(
              inspection,
              workspace,
              unavailable,
            );
      throw new CheckIncompleteError({
        code: "COMPARISON_INSTALLATION_UNAVAILABLE",
        message:
          labels === undefined
            ? INSTALLATION_MESSAGE
            : `Analysis is incomplete because declared package '${labels.name}' is unavailable to workspace '${labels.workspace}' in the ${options.side} snapshot.`,
        remediation:
          labels === undefined
            ? INSTALLATION_REMEDIATION
            : `Restore '${labels.name}' using this workspace's package-manager and lockfile workflow, then rerun the scan.`,
        path: workspace.manifestPath,
        snapshot: options.side === "baseline" ? "last-commit" : "staged",
      });
    }
}

export function verifyComparisonInputs(
  dependencies: CapturedDependencies,
): ComparisonContext {
  const manifest = dependencies.manifest();
  const failure = dependencies.failure();
  if (failure?.reason === "capacity") {
    const labels = {
      metadataBytes: "metadata bytes",
      probes: "dependency probes",
      bytes: "retained file bytes",
      fileBytes: "bytes per dependency file",
      names: "directory entry names",
    };
    throw new CheckIncompleteError({
      code: "COMPARISON_INPUTS_LIMIT_EXCEEDED",
      message: `Dependency tracking exceeded its ${labels[failure.resource]} limit (observed ${failure.observed}; limit ${failure.limit}).`,
      remediation:
        "Share this capacity diagnostic with the Swarm maintainer so the supported project size can be reviewed.",
    });
  }
  if (failure !== undefined) {
    throw new CheckIncompleteError({
      code:
        failure.reason === "inputs-changed"
          ? "COMPARISON_INPUTS_CHANGED"
          : "COMPARISON_INPUTS_UNVERIFIED",
      message:
        failure.reason === "unsupported-scope"
          ? "Analysis could not track a dependency lookup within the supported project and installation boundaries."
          : failure.reason === "inputs-changed"
            ? "Required dependency inputs changed during this scan."
            : failure.reason === "unreadable-input"
              ? "A required dependency input could not be read safely."
              : "Dependency tracking could not produce validated comparison metadata.",
      remediation:
        failure.reason === "inputs-changed"
          ? "Wait for dependency installation or updates to finish, then rerun the scan."
          : "Verify the workspace installation and supported layout. Include this diagnostic in a Swarm issue if normal project lookups cannot be verified.",
    });
  }
  if (manifest === undefined)
    return comparisonContext("unverified", "unsupported-inputs");
  if (!dependencies.validate(manifest))
    throw new CheckIncompleteError({
      code: "COMPARISON_INPUTS_CHANGED",
      message:
        "Analysis could not complete because required installation inputs changed during this scan.",
      remediation:
        "Wait for installation or dependency updates to finish and rerun.",
    });
  return comparisonContext();
}

export function incompleteComparisonContext(
  code: string | undefined,
): ComparisonContext | undefined {
  if (code === "COMPARISON_INSTALLATION_UNAVAILABLE")
    return comparisonContext(
      "environment-incomplete",
      "required-installation-unavailable",
    );
  if (code === "COMPARISON_INPUTS_CHANGED")
    return comparisonContext("unverified", "inputs-changed");
  if (
    code === "COMPARISON_INPUTS_UNVERIFIED" ||
    code === "COMPARISON_INPUTS_LIMIT_EXCEEDED"
  )
    return comparisonContext("unverified", "unsupported-inputs");
  return undefined;
}
