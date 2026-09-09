import { runAnalyzerJob } from "../checks/runner/run-job.js";
import { normalizeRepositoryRelativePath } from "../attribution/fingerprint.js";
import type { CheckRunContext } from "../checks/adapter.js";
import type { FormattingSettings } from "../checks/prettier/settings.js";
import { prettierParserFor } from "../checks/prettier/supported-path.js";
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
 * The candidate deliberately contains settings instead of a source snapshot:
 * applying it later formats the then-current working file.
 */
export function planPrettierFixes(
  context: CheckRunContext,
  findings: readonly Finding[],
): readonly FormatFileFixCandidate[] {
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

  const candidates = [...findingsByFile.entries()]
    .sort(([left], [right]) => compareCodeUnits(left, right))
    .flatMap(([file, fileFindings]) => {
      const policy = context.policyForFile("formatting", file, "target");
      if (policy.severity === "off") return [];
      if (prettierParserFor(file) === undefined) return [];
      const sortedFindings = [...fileFindings].sort((left, right) =>
        compareCodeUnits(left.id, right.id),
      );
      return [
        {
          kind: "format-file" as const,
          checkId: "formatting" as const,
          file,
          findingIds: sortedFindings.map((finding) => finding.id),
          severities: sortedFindings.map((finding) => finding.severity),
          settings: policy.settings,
        },
      ];
    });
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
