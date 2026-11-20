import { lstat, realpath } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { isContainedPath } from "../inspection/read-json.js";
import type { WorkspaceInspection } from "../inspection/types.js";

// Readiness inspects metadata only: no imports, compiler programs, package
// contents, directory enumeration, version resolution, or network requests.
const MAX_WORKSPACES = 512;
const MAX_DECLARATIONS = 8_192;
const MAX_PROBES = 4_096;
const MAX_ANCESTORS = 64;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_REPORTED_GAPS = 8;

interface InstallationGap {
  readonly workspace: string;
  readonly name: string;
  readonly kind: "missing" | "unverified";
}

export interface WorkspaceInstallationReadiness {
  readonly status: "pass" | "warning";
  readonly summary: string;
}

function supportedInstalledPath(
  checkout: string,
  rootPackages: string | undefined,
  path: string,
): boolean {
  if (rootPackages !== undefined && isContainedPath(rootPackages, path))
    return true;
  return (
    isContainedPath(checkout, path) &&
    relative(checkout, path).split(sep).includes("node_modules")
  );
}

/** Check selected declarations against this checkout's bounded installation
 * surface. A present manifest is a setup hint, never compiler comparability. */
export async function inspectWorkspaceInstallations(
  repositoryRoot: string,
  workspaces: readonly Pick<
    WorkspaceInspection,
    "relativeRoot" | "dependencyDeclarations"
  >[],
): Promise<WorkspaceInstallationReadiness> {
  const checkout = await realpath(repositoryRoot);
  const rootPackages = await realpath(join(checkout, "node_modules")).catch(
    () => undefined,
  );
  const observed = new Map<string, "present" | "missing" | "unverified">();
  const gaps: InstallationGap[] = [];
  let gapCount = 0;
  let declarations = 0;
  let limited = workspaces.length > MAX_WORKSPACES;
  const gap = (
    workspace: string,
    name: string,
    kind: InstallationGap["kind"],
  ) => {
    gapCount++;
    if (gaps.length < MAX_REPORTED_GAPS)
      gaps.push({ workspace, name, kind });
  };
  const probe = async (path: string) => {
    const cached = observed.get(path);
    if (cached !== undefined) return cached;
    if (observed.size >= MAX_PROBES) {
      limited = true;
      return "unverified" as const;
    }
    let result: "present" | "missing" | "unverified" = "unverified";
    try {
      const canonical = await realpath(path);
      // Do not inspect metadata beyond the same installed-package containment
      // accepted by scans (including a canonical root node_modules link).
      if (supportedInstalledPath(checkout, rootPackages, canonical)) {
        const metadata = await lstat(canonical);
        if (metadata.isFile() && metadata.size <= MAX_MANIFEST_BYTES)
          result = "present";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // Check from the checkout downward so an absent leaf behind an
        // unsupported link is never mistaken for an absent installation.
        const components = relative(checkout, path).split(sep);
        let ancestor = checkout;
        if (components.length <= MAX_ANCESTORS) {
          for (const component of components) {
            ancestor = join(ancestor, component);
            try {
              const canonical = await realpath(ancestor);
              const metadata = await lstat(ancestor);
              if (
                metadata.isSymbolicLink() &&
                !supportedInstalledPath(checkout, rootPackages, canonical)
              )
                break;
              if (
                !isContainedPath(checkout, canonical) &&
                !supportedInstalledPath(checkout, rootPackages, canonical)
              )
                break;
            } catch (ancestorError) {
              if (
                (ancestorError as NodeJS.ErrnoException).code !== "ENOENT"
              )
                break;
              try {
                // A dangling link exists lexically, but its target is not a
                // supported installation. Only genuine absence is missing.
                await lstat(ancestor);
              } catch (metadataError) {
                if (
                  (metadataError as NodeJS.ErrnoException).code === "ENOENT"
                )
                  result = "missing";
              }
              break;
            }
          }
        } else limited = true;
      }
    }
    observed.set(path, result);
    return result;
  };

  outer: for (const workspace of workspaces.slice(0, MAX_WORKSPACES)) {
    const project = resolve(checkout, workspace.relativeRoot);
    if (
      !isContainedPath(checkout, project) ||
      workspace.relativeRoot.length > 512
    ) {
      limited = true;
      continue;
    }
    const names = new Set<string>();
    for (const declaration of workspace.dependencyDeclarations) {
      if (++declarations > MAX_DECLARATIONS) {
        limited = true;
        break outer;
      }
      // Optional packages and peers may legitimately be absent. This deliberately
      // checks declared typings only, not every tool or source import.
      if (
        !["dependencies", "devDependencies"].includes(
          declaration.section,
        ) ||
        !declaration.name.startsWith("@types/")
      )
        continue;
      if (
        declaration.name.length > 214 ||
        !/^@types\/[a-z0-9][a-z0-9._-]*$/iu.test(declaration.name)
      ) {
        limited = true;
        continue;
      }
      names.add(declaration.name);
    }
    for (const name of [...names].sort()) {
      let directory = project;
      let outcome: "present" | "missing" | "unverified" = "unverified";
      for (let depth = 0; depth < MAX_ANCESTORS; depth++) {
        outcome = await probe(
          join(directory, "node_modules", name, "package.json"),
        );
        if (outcome !== "missing" || directory === checkout) break;
        directory = dirname(directory);
        if (depth === MAX_ANCESTORS - 1) {
          outcome = "unverified";
          limited = true;
        }
      }
      if (outcome !== "present") gap(workspace.relativeRoot, name, outcome);
      if (limited && observed.size >= MAX_PROBES) break outer;
    }
  }
  const parts: string[] = [];
  for (const kind of ["missing", "unverified"] as const) {
    const grouped = new Map<string, string[]>();
    for (const entry of gaps.filter((entry) => entry.kind === kind)) {
      const names = grouped.get(entry.workspace) ?? [];
      names.push(entry.name);
      grouped.set(entry.workspace, names);
    }
    if (grouped.size > 0) {
      const locations = [...grouped].map(([workspace, names]) => {
        const label = workspace === "." ? "root" : workspace;
        return `${label.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`)}: ${names.join(", ")}`;
      });
      parts.push(
        `${kind === "missing" ? "Missing" : "Readiness could not verify"} declared @types packages (${locations.join("; ")}).`,
      );
    }
  }
  if (gapCount > gaps.length)
    parts.push(
      `${gapCount - gaps.length} additional installation gaps are not listed.`,
    );
  if (limited)
    parts.push(
      "The bounded declared @types readiness inspection was not completed.",
    );
  return {
    status: gapCount > 0 || limited ? "warning" : "pass",
    summary:
      parts.length > 0
        ? parts.join(" ")
        : "Declared @types package manifests are available within the supported installation scope.",
  };
}
