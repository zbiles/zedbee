import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
import type { ICruiseResult, IViolation } from "dependency-cruiser";
import { normalizeRepositoryRelativePath } from "../../attribution/fingerprint.js";
import { compareCodeUnits } from "../../core/compare.js";
import type { Observation } from "../../core/types.js";
import { DEPENDENCY_RULE_NAMES } from "./rules.js";

const RULES = new Set<string>(Object.values(DEPENDENCY_RULE_NAMES));
const TEST_PATH =
  /(^|\/)(?:test|tests|__tests__|spec)(?:\/|$)|\.(?:test|spec)\.[^.]+$/u;

export interface DependencyDeclarations {
  readonly production: ReadonlySet<string>;
  readonly development: ReadonlySet<string>;
  readonly aliases?: readonly string[];
  readonly workspacePackages?: ReadonlySet<string>;
}

function canonicalText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`Expected canonical ${field}`);
  }
  return value;
}

function repositoryPath(path: string, snapshotRoot: string): string {
  const candidate = canonicalText(path, "dependency path");
  return normalizeRepositoryRelativePath(
    isAbsolute(candidate)
      ? relative(snapshotRoot, candidate).split(sep).join("/")
      : candidate.replaceAll("\\", "/"),
  );
}

function rotations(nodes: readonly string[]): string[][] {
  return nodes.map((_, index) => [
    ...nodes.slice(index),
    ...nodes.slice(0, index),
  ]);
}

export function canonicalCycle(nodes: readonly string[]): readonly string[] {
  if (!Array.isArray(nodes) || nodes.length < 2) {
    throw new TypeError("Expected a dependency cycle");
  }
  const normalized = nodes.map((node) =>
    normalizeRepositoryRelativePath(node.replaceAll("\\", "/")),
  );
  const withoutClosingNode =
    normalized.length > 2 && normalized[0] === normalized.at(-1)
      ? normalized.slice(0, -1)
      : normalized;
  if (new Set(withoutClosingNode).size !== withoutClosingNode.length) {
    throw new TypeError("Expected unique dependency cycle nodes");
  }
  const candidates = [
    ...rotations(withoutClosingNode),
    ...rotations([...withoutClosingNode].reverse()),
  ].sort((left, right) =>
    compareCodeUnits(JSON.stringify(left), JSON.stringify(right)),
  );
  return Object.freeze(candidates[0]!);
}

function violationTarget(violation: IViolation, snapshotRoot: string): string {
  if (violation.unresolvedTo !== undefined) {
    return canonicalText(violation.unresolvedTo, "unresolved dependency");
  }
  const to = canonicalText(violation.to, "dependency target");
  if (isAbsolute(to) || to.startsWith(".") || to.includes("/")) {
    try {
      return repositoryPath(to, snapshotRoot);
    } catch {
      return createHash("sha256").update(to, "utf8").digest("hex");
    }
  }
  return to;
}

function message(rule: string): string {
  switch (rule) {
    case DEPENDENCY_RULE_NAMES.circular:
      return "Dependency cycle introduced or enlarged.";
    case DEPENDENCY_RULE_NAMES.unresolved:
      return "Import cannot be resolved.";
    case DEPENDENCY_RULE_NAMES.missingDependency:
      return "Imported package is not declared as a production dependency.";
    case DEPENDENCY_RULE_NAMES.productionToDev:
      return "Production source imports a development-only dependency.";
    case DEPENDENCY_RULE_NAMES.sourceToTest:
      return "Production source imports test-only code.";
    default:
      throw new TypeError("Unsupported dependency rule");
  }
}

function packageName(specifier: string): string | undefined {
  if (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("#") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("~/") ||
    /^[A-Za-z][A-Za-z+.-]*:/u.test(specifier)
  ) {
    return undefined;
  }
  const parts = specifier.split("/");
  const name = specifier.startsWith("@")
    ? parts.length >= 2
      ? `${parts[0]}/${parts[1]}`
      : undefined
    : parts[0];
  return name === undefined || name.length === 0 ? undefined : name;
}

function observation(rule: string, from: string, to: string): Observation {
  return {
    check: "dependencyArchitecture",
    rule,
    identity: `edge:${rule}:${from}->${to}`,
    severity: "error",
    message: message(rule),
    location: { file: from },
  };
}

function matchesAlias(specifier: string, aliases: readonly string[]): boolean {
  return aliases.some((alias) => {
    const star = alias.indexOf("*");
    return star === -1
      ? alias === specifier
      : specifier.startsWith(alias.slice(0, star)) &&
          specifier.endsWith(alias.slice(star + 1));
  });
}

function declarationObservations(
  result: ICruiseResult,
  snapshotRoot: string,
  allowedSources: ReadonlySet<string>,
  declarations: DependencyDeclarations,
): readonly Observation[] {
  const observations: Observation[] = [];
  for (const module of result.modules) {
    const from = repositoryPath(module.source, snapshotRoot);
    if (!allowedSources.has(from) || TEST_PATH.test(from)) continue;
    for (const dependency of module.dependencies) {
      const specifier = canonicalText(
        dependency.module,
        "dependency specifier",
      );
      const dependencyName = packageName(specifier);
      if (dependencyName === undefined) continue;
      const workspacePackage =
        declarations.workspacePackages?.has(dependencyName) === true;
      if (
        !workspacePackage &&
        matchesAlias(specifier, declarations.aliases ?? [])
      ) {
        continue;
      }
      if (
        !workspacePackage &&
        dependency.dependencyTypes.some(
          (type) =>
            type === "core" ||
            type === "local" ||
            type === "localmodule" ||
            type.startsWith("aliased"),
        )
      ) {
        continue;
      }
      const production = declarations.production.has(dependencyName);
      const development = declarations.development.has(dependencyName);
      if (development && !production) {
        observations.push(
          observation(
            DEPENDENCY_RULE_NAMES.productionToDev,
            from,
            dependencyName,
          ),
        );
      } else if (!production && !development) {
        observations.push(
          observation(
            DEPENDENCY_RULE_NAMES.missingDependency,
            from,
            dependencyName,
          ),
        );
      }
    }
  }
  return observations;
}

function cycleNodes(
  violation: IViolation,
  from: string,
  to: string,
  snapshotRoot: string,
): readonly string[] {
  const reported = (violation.cycle ?? []).map(({ name }) =>
    repositoryPath(name, snapshotRoot),
  );
  const nodes = [...new Set([from, to, ...reported])];
  return canonicalCycle(nodes);
}

export function normalizeDependencyViolations(
  result: ICruiseResult,
  snapshotRoot: string,
  allowedSources: ReadonlySet<string>,
  declarations: DependencyDeclarations = {
    production: new Set<string>(),
    development: new Set<string>(),
  },
): readonly Observation[] {
  if (
    typeof result !== "object" ||
    result === null ||
    !Array.isArray(result.modules) ||
    typeof result.summary !== "object" ||
    result.summary === null ||
    !Array.isArray(result.summary.violations)
  ) {
    throw new TypeError("Expected dependency-cruiser result");
  }
  const observations = result.summary.violations.flatMap(
    (violation): readonly Observation[] => {
      const rule = canonicalText(violation.rule?.name, "dependency rule");
      if (!RULES.has(rule)) throw new TypeError("Unsupported dependency rule");
      const reportedFrom = repositoryPath(violation.from, snapshotRoot);
      const reportedCycle = (violation.cycle ?? []).map(({ name }) =>
        repositoryPath(name, snapshotRoot),
      );
      const from = allowedSources.has(reportedFrom)
        ? reportedFrom
        : rule === DEPENDENCY_RULE_NAMES.circular
          ? reportedCycle.find((path) => allowedSources.has(path))
          : undefined;
      if (from === undefined) {
        return [];
      }
      const cycleIndex = reportedCycle.indexOf(from);
      const to =
        cycleIndex === -1
          ? violationTarget(violation, snapshotRoot)
          : reportedCycle[(cycleIndex + 1) % reportedCycle.length]!;
      if (
        rule === DEPENDENCY_RULE_NAMES.unresolved &&
        packageName(violation.unresolvedTo ?? violation.to) !== undefined &&
        !declarations.workspacePackages?.has(
          packageName(violation.unresolvedTo ?? violation.to)!,
        )
      ) {
        return [];
      }
      const cycle =
        rule === DEPENDENCY_RULE_NAMES.circular
          ? cycleNodes(violation, from, to, snapshotRoot)
          : undefined;
      if (cycle !== undefined) {
        const identity = `cycle:${cycle.join(">")}`;
        return cycle
          .filter((path) => allowedSources.has(path))
          .map((path) => ({
            check: "dependencyArchitecture",
            rule,
            identity,
            severity: "error" as const,
            message: message(rule),
            location: { file: path },
          }));
      }
      return [
        {
          check: "dependencyArchitecture",
          rule,
          identity: `edge:${rule}:${from}->${to}`,
          severity: "error",
          message: message(rule),
          location: { file: from },
        },
      ];
    },
  );
  const unique = new Map<string, Observation>();
  for (const observation of [
    ...observations,
    ...declarationObservations(
      result,
      snapshotRoot,
      allowedSources,
      declarations,
    ),
  ]) {
    const key = `${observation.rule}:${observation.identity}:${observation.location?.file}`;
    unique.set(key, observation);
  }
  return Object.freeze(
    [...unique.values()].sort((left, right) =>
      compareCodeUnits(left.identity, right.identity),
    ),
  );
}
