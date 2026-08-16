import { createHash, createHmac, randomBytes } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Observation } from "../../core/types.js";
import { compareCodeUnits } from "../../core/compare.js";
import type {
  CheckObservationSet,
  CheckRunContext,
  InspectionContext,
  ObservationCheckAdapter,
} from "../adapter.js";
import { createManagedOutputDirectory } from "../project/config-boundary.js";
import { resolveManagedBinary } from "../../managed-binaries/resolve.js";
import { runManagedBinary } from "../../managed-binaries/run.js";
import type {
  ManagedBinary,
  ManagedRunOptions,
  ManagedRunResult,
} from "../../managed-binaries/types.js";
import {
  parseAndRedactGitleaksReport,
  type RedactedGitleaksFinding,
} from "./redact.js";

const REPORT = "gitleaks.json";
const TARGET = Object.freeze({
  id: ".",
  kind: "repository" as const,
  relativeRoot: ".",
});

interface SecretsAdapterDependencies {
  readonly resolveBinary: typeof resolveManagedBinary;
  readonly runBinary: (
    binary: ManagedBinary,
    args: readonly string[],
    options: ManagedRunOptions,
  ) => Promise<ManagedRunResult>;
}

const defaults: SecretsAdapterDependencies = {
  resolveBinary: resolveManagedBinary,
  runBinary: runManagedBinary,
};

function normalizedFile(snapshotRoot: string, file: string): string {
  const root = resolve(snapshotRoot);
  const absolute = isAbsolute(file) ? resolve(file) : resolve(root, file);
  const path = relative(root, absolute).replaceAll("\\", "/");
  if (
    path.length === 0 ||
    path === ".." ||
    path.startsWith("../") ||
    isAbsolute(path)
  ) {
    throw new TypeError("Gitleaks returned an invalid report");
  }
  return path;
}

function observation(
  finding: RedactedGitleaksFinding,
  snapshotRoot: string,
  comparisonIdentity: string,
): Observation {
  const file = normalizedFile(snapshotRoot, finding.file);
  const location = {
    file,
    startLine: finding.startLine,
    endLine: finding.endLine,
    startColumn: finding.startColumn,
    endColumn: finding.endColumn,
  };
  const identity = createHash("sha256")
    .update(JSON.stringify([finding.ruleId, location]))
    .digest("hex");
  return Object.freeze({
    check: "secrets",
    rule: finding.ruleId,
    identity,
    comparisonIdentity,
    severity: "error",
    message: `Potential secret detected by Gitleaks rule ${finding.ruleId}.`,
    location: Object.freeze(location),
    remediation:
      "Remove the secret, rotate the credential, and commit only a safe reference.",
  });
}

function contained(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return (
    path !== ".." &&
    !path.startsWith("../") &&
    !path.startsWith("..\\") &&
    !isAbsolute(path)
  );
}

async function comparisonIdentity(
  snapshotRoot: string,
  finding: RedactedGitleaksFinding,
  comparisonKey: Uint8Array,
): Promise<string> {
  const file = normalizedFile(snapshotRoot, finding.file);
  const canonicalRoot = await realpath(snapshotRoot);
  const candidate = await realpath(resolve(canonicalRoot, file));
  if (!contained(canonicalRoot, candidate)) {
    throw new TypeError("Gitleaks returned an invalid report");
  }
  const lines = (await readFile(candidate, "utf8")).split(/\r\n|\n|\r/u);
  const startLine = lines[finding.startLine - 1];
  const endLine = lines[finding.endLine - 1];
  if (startLine === undefined || endLine === undefined) {
    throw new TypeError("Gitleaks returned an invalid report");
  }
  const selected = lines
    .slice(finding.startLine - 1, finding.endLine)
    .map((line, index, all) => {
      const codePoints = Array.from(line);
      const start = index === 0 ? finding.startColumn - 1 : 0;
      const end =
        index === all.length - 1 ? finding.endColumn : codePoints.length;
      if (start > codePoints.length || end > codePoints.length || end < start) {
        throw new TypeError("Gitleaks returned an invalid report");
      }
      return codePoints.slice(start, end).join("");
    })
    .join("\n");
  return createHmac("sha256", comparisonKey)
    .update(selected, "utf8")
    .digest("hex");
}

async function collectSide(
  dependencies: SecretsAdapterDependencies,
  binary: ManagedBinary,
  snapshotRoot: string,
  signal: AbortSignal,
  comparisonKey: Uint8Array,
): Promise<readonly Observation[]> {
  if (binary.configPath === undefined)
    throw new Error("Secret analysis failed.");
  const output = await createManagedOutputDirectory("gitleaks", [REPORT]);
  try {
    await dependencies.runBinary(
      binary,
      [
        "dir",
        "--no-banner",
        "--redact",
        "--config",
        binary.configPath,
        "--report-format",
        "json",
        "--report-path",
        resolve(output.path, REPORT),
        snapshotRoot,
      ],
      {
        cwd: snapshotRoot,
        timeoutMs: 60_000,
        signal,
        acceptedExitCodes: [0, 1],
      },
    );
    let rawReport = await output.readText(REPORT);
    const redacted = parseAndRedactGitleaksReport(rawReport);
    rawReport = "";
    return Object.freeze(
      (
        await Promise.all(
          redacted.map(async (finding) =>
            observation(
              finding,
              snapshotRoot,
              await comparisonIdentity(snapshotRoot, finding, comparisonKey),
            ),
          ),
        )
      ).sort((left, right) => compareCodeUnits(left.identity, right.identity)),
    );
  } finally {
    await output.cleanup();
  }
}

export function createSecretsAdapter(
  dependencies: SecretsAdapterDependencies = defaults,
): ObservationCheckAdapter {
  return Object.freeze({
    id: "secrets",
    output: "observations" as const,
    async inspect(context: InspectionContext) {
      const changedFiles = [...context.changeSet.files.values()].filter(
        ({ status }) => status !== "deleted",
      );
      if (changedFiles.length === 0) {
        return { applies: false as const, reason: "No staged files to scan" };
      }
      return {
        applies: true as const,
        executionClass: "project-analysis" as const,
        requiresBaseline: true,
        targets: [TARGET],
      };
    },
    async collect(context: CheckRunContext): Promise<CheckObservationSet> {
      try {
        const binary = await dependencies.resolveBinary("gitleaks");
        const comparisonKey = randomBytes(32);
        const baselineObservations = await collectSide(
          dependencies,
          binary,
          context.snapshots.baselineDir,
          context.signal,
          comparisonKey,
        );
        const targetObservations = await collectSide(
          dependencies,
          binary,
          context.snapshots.targetDir,
          context.signal,
          comparisonKey,
        );
        return {
          checkId: "secrets",
          target: context.target,
          baselineObservations,
          targetObservations,
        };
      } catch {
        throw new Error("Secret analysis failed.");
      }
    },
  });
}

export const secretsAdapter = createSecretsAdapter();
