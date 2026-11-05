import type { FilePolicyResolver } from "../config/file-policy.js";
import { runAnalyzerJob } from "../checks/runner/run-job.js";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import type {
  CheckRunContext,
  CheckExecutionResult,
} from "../checks/adapter.js";
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
import type {
  FormatFileFixCandidate,
  CheckFixCandidate,
  FixableCheckId,
} from "./types.js";

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

function resolvePolicyForFile(
  executions: readonly CheckExecutionResult[],
): FilePolicyResolver | undefined {
  return executions.find((execution) => execution.policyForFile !== undefined)
    ?.policyForFile;
}

export function addFormattingForExactCandidates(
  candidates: readonly CheckFixCandidate[],
  selected: ReadonlySet<FixableCheckId>,
  executions: readonly CheckExecutionResult[],
): readonly CheckFixCandidate[] {
  if (!selected.has("formatting")) return candidates;
  const policyForFile = resolvePolicyForFile(executions);
  if (policyForFile === undefined) return candidates;

  const byFile = new Map<string, FormatFileFixCandidate>();
  for (const candidate of candidates) {
    if (candidate.kind !== "format-file") continue;
    byFile.set(candidate.file, candidate);
  }
  for (const candidate of candidates) {
    if (
      candidate.kind !== "exact-file" ||
      prettierParserFor(candidate.file) === undefined
    ) {
      continue;
    }
    const policy = policyForFile("formatting", candidate.file, "target");
    if (policy.severity === "off") continue;
    // Project-engine files are formatted by their own engine through the
    // formatting finding path, never by bundling managed settings here.
    if (policy.engine === "project") continue;
    const existing = byFile.get(candidate.file);
    const findingIds = [
      ...(existing?.findingIds ?? []),
      ...candidate.edits.map((edit) => edit.findingId),
    ];
    const severities = [
      ...(existing?.severities ?? []),
      ...candidate.edits.map((edit) => edit.severity),
    ];
    const [formatCandidate] = sanitizeFixCandidates(
      [
        {
          kind: "format-file",
          checkId: "formatting",
          file: candidate.file,
          findingIds,
          severities,
          settings: policy.settings,
        },
      ],
      { checkId: "formatting", findingIds },
    );
    byFile.set(candidate.file, formatCandidate as FormatFileFixCandidate);
  }
  const otherCandidates = candidates.filter(
    (candidate) => candidate.kind !== "format-file",
  );
  const formattingCandidates = [...byFile.values()];
  return Object.freeze([...otherCandidates, ...formattingCandidates]);
}
