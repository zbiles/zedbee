import { runAnalyzerJob } from "../checks/runner/run-job.js";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import type { CheckRunContext } from "../checks/adapter.js";
import type { FormattingSettings } from "../checks/prettier/settings.js";
import { prettierParserFor } from "../checks/prettier/supported-path.js";
import type { FormattingFixSelection } from "../checks/prettier/project-types.js";
import {
  owningProjectRoot,
  resolveProjectPrettierInstallation,
  snapshotIdentity,
} from "../checks/prettier/project-engine.js";
import { compareCodeUnits } from "../core/compare.js";
import type { Finding } from "../core/types.js";
import { sanitizeFixCandidates } from "./sanitize.js";
import type { FormatFileFixCandidate } from "./types.js";

function isFixableFormattingFinding(finding: Finding): finding is Finding & {
  readonly severity: "warning" | "error";
  readonly location: NonNullable<Finding["location"]>;
} {
  return (
    finding.check === "formatting" &&
    finding.location !== undefined &&
    (finding.severity === "warning" || finding.severity === "error")
  );
}

/**
 * Plans whole-working-file formatting for the reported target findings only.
 * The candidate deliberately contains settings or a project engine reference
 * instead of a source snapshot: applying it later formats the then-current
 * working file.
 */
export async function planPrettierFixes(
  context: CheckRunContext,
  findings: readonly Finding[],
): Promise<readonly FormatFileFixCandidate[]> {
  const findingsByFile = new Map<string, Finding[]>();
  for (const finding of findings) {
    if (!isFixableFormattingFinding(finding)) continue;
    const file = normalizeRepositoryRelativePath(finding.location.file);
    const fileFindings = findingsByFile.get(file);
    if (fileFindings === undefined) {
      findingsByFile.set(file, [finding]);
    } else {
      fileFindings.push(finding);
    }
  }

  let projectSnapshotIdentity: string | undefined;
  const candidates: FormatFileFixCandidate[] = [];
  for (const [file, fileFindings] of [...findingsByFile.entries()].sort(
    ([left], [right]) => compareCodeUnits(left, right),
  )) {
    const policy = context.policyForFile("formatting", file, "target");
    if (policy.severity === "off") continue;
    const isProject = policy.engine === "project";
    if (!isProject && prettierParserFor(file) === undefined) continue;
    let selection: FormattingFixSelection = {
      engine: "managed",
      settings: policy.settings,
    };
    if (isProject) {
      const projectRoot = owningProjectRoot(
        context.targetInspection.workspaces,
        file,
      );
      const installation = await resolveProjectPrettierInstallation(
        context.repositoryRoot,
        projectRoot,
        context.snapshots.targetDir,
      );
      projectSnapshotIdentity ??= await snapshotIdentity(
        context.snapshots.targetDir,
      );
      selection = {
        engine: "project",
        projectRoot,
        installationIdentity: installation.identity,
        snapshotIdentity: projectSnapshotIdentity,
      };
    }
    const sortedFindings = [...fileFindings].sort((left, right) =>
      compareCodeUnits(left.id, right.id),
    );
    candidates.push({
      kind: "format-file",
      checkId: "formatting",
      file,
      findingIds: sortedFindings.map((finding) => finding.id),
      severities: sortedFindings.map((finding) =>
        finding.severity === "error" ? "error" : "warning",
      ),
      settings: policy.settings,
      selection,
    });
  }
  const sanitized = sanitizeFixCandidates(candidates, {
    checkId: "formatting",
    findingIds: candidates.flatMap((candidate) => candidate.findingIds),
  });
  return Object.freeze(
    sanitized.map((candidate) => {
      if (candidate.kind !== "format-file") {
        throw new TypeError("Expected a Prettier format-file fix candidate");
      }
      return candidate;
    }),
  );
}

export async function formatWorkingSource(
  input: {
    readonly file: string;
    readonly source: string;
    readonly settings: Readonly<FormattingSettings>;
  },
  options: { readonly signal?: AbortSignal } = {},
): Promise<string> {
  const file = normalizeRepositoryRelativePath(input.file);
  const parser = prettierParserFor(file);
  if (parser === undefined) {
    throw new TypeError("Expected a supported Prettier file path");
  }
  return runAnalyzerJob(
    {
      version: 1,
      checkId: "formatting",
      operation: "format-working-source",
      input: { ...input, file },
    },
    options,
  );
}
