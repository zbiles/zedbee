import { compareCodeUnits } from "../core/compare.js";
import {
  createExactEditMapping,
  overlappingExactEdits,
} from "./exact-edits.js";
import type {
  CheckFixCandidate,
  ExactFileFixCandidate,
  ExactFixEdit,
  FormatFileFixCandidate,
  FixPlanItem,
  FixableCheckId,
  WorkingFilePreview,
} from "./types.js";

interface FixPlanItemDraft {
  readonly checkId: FixableCheckId;
  readonly file: string;
  readonly findingIds: readonly string[];
  readonly scope: "finding" | "working-file";
  readonly fixes: number;
  readonly status: "applicable" | "skipped";
  readonly reason?: string;
  readonly severities: readonly Readonly<{
    findingId: string;
    severity: "warning" | "error";
  }>[];
}

function itemForExact(
  candidate: ExactFileFixCandidate,
  edits: readonly ExactFixEdit[],
  reason?: string,
): FixPlanItemDraft {
  return Object.freeze({
    checkId: candidate.checkId,
    file: candidate.file,
    findingIds: Object.freeze([
      ...new Set(edits.map((edit) => edit.findingId)),
    ]),
    scope: "finding" as const,
    fixes: edits.length,
    status:
      reason === undefined ? ("applicable" as const) : ("skipped" as const),
    ...(reason === undefined ? {} : { reason }),
    severities: Object.freeze(
      edits.map((edit) => ({
        findingId: edit.findingId,
        severity: edit.severity,
      })),
    ),
  });
}

function itemForFormatting(
  candidate: FormatFileFixCandidate,
): FixPlanItemDraft {
  return Object.freeze({
    checkId: candidate.checkId,
    file: candidate.file,
    findingIds: Object.freeze([...new Set(candidate.findingIds)]),
    scope: "working-file" as const,
    fixes: 1,
    status: "applicable" as const,
    severities: Object.freeze(
      candidate.findingIds.map((findingId, index) => ({
        findingId,
        severity: candidate.severities[index]!,
      })),
    ),
  });
}

function finalizeItems(
  drafts: readonly FixPlanItemDraft[],
): readonly FixPlanItem[] {
  const countedFindings = new Set<string>();
  return Object.freeze(
    drafts
      .map((draft): FixPlanItem => {
        const severities = new Map<string, "warning" | "error">();
        for (const entry of draft.severities) {
          if (
            severities.get(entry.findingId) !== "error" ||
            entry.severity === "error"
          ) {
            severities.set(entry.findingId, entry.severity);
          }
        }
        const unique = [...severities].filter(([findingId]) => {
          if (countedFindings.has(findingId)) return false;
          countedFindings.add(findingId);
          return true;
        });
        return Object.freeze({
          checkId: draft.checkId,
          file: draft.file,
          findingIds: draft.findingIds,
          scope: draft.scope,
          fixes: draft.fixes,
          blocking: unique.filter(([, severity]) => severity === "error")
            .length,
          warnings: unique.filter(([, severity]) => severity === "warning")
            .length,
          status: draft.status,
          ...(draft.reason === undefined ? {} : { reason: draft.reason }),
        });
      })
      .sort(compareItems),
  );
}

function compareItems(left: FixPlanItem, right: FixPlanItem): number {
  return (
    compareCodeUnits(left.file, right.file) ||
    compareCodeUnits(left.checkId, right.checkId) ||
    compareCodeUnits(left.scope, right.scope) ||
    compareCodeUnits(left.findingIds[0] ?? "", right.findingIds[0] ?? "")
  );
}

interface PlannedCandidates {
  readonly candidates: readonly CheckFixCandidate[];
  readonly items: readonly FixPlanItem[];
}

const WORKING_OVERLAP_REASON = "Working changes overlap a managed exact fix.";
const MAPPING_LIMIT_REASON =
  "Managed exact fixes could not be mapped within the preview time limit.";
const MANAGED_OVERLAP_REASON = "Managed exact fixes overlap each other.";
const INCOMPATIBLE_BASE_REASON =
  "Managed exact fixes use incompatible staged sources.";

export function planCandidates(
  candidates: readonly CheckFixCandidate[],
  workingFiles: ReadonlyMap<string, WorkingFilePreview>,
): PlannedCandidates {
  const reasons = new Map<ExactFixEdit, string>();
  const exactByFile = new Map<string, ExactFileFixCandidate[]>();
  for (const candidate of candidates) {
    if (candidate.kind !== "exact-file") continue;
    const existing = exactByFile.get(candidate.file);
    if (existing === undefined) exactByFile.set(candidate.file, [candidate]);
    else existing.push(candidate);
  }

  for (const [file, exactCandidates] of exactByFile) {
    const baseSource = exactCandidates[0]!.baseSource;
    const entries = exactCandidates.flatMap((candidate) =>
      candidate.edits.map((edit) => ({ candidate, edit })),
    );
    if (
      exactCandidates.some((candidate) => candidate.baseSource !== baseSource)
    ) {
      for (const { edit } of entries)
        reasons.set(edit, INCOMPATIBLE_BASE_REASON);
      continue;
    }
    for (const edit of overlappingExactEdits(entries.map(({ edit }) => edit))) {
      reasons.set(edit, MANAGED_OVERLAP_REASON);
    }
    const preview = workingFiles.get(file);
    const mapping =
      preview === undefined
        ? undefined
        : createExactEditMapping(baseSource, preview.content);
    for (const { edit } of entries) {
      if (reasons.has(edit)) continue;
      if (mapping?.mapEdit(edit) === undefined) {
        reasons.set(
          edit,
          preview !== undefined && mapping === undefined
            ? MAPPING_LIMIT_REASON
            : WORKING_OVERLAP_REASON,
        );
      }
    }
  }

  const itemDrafts: FixPlanItemDraft[] = [];
  const applicable: CheckFixCandidate[] = [];
  for (const candidate of candidates) {
    if (candidate.kind === "format-file") {
      itemDrafts.push(itemForFormatting(candidate));
      applicable.push(candidate);
      continue;
    }
    const edits = candidate.edits.filter((edit) => !reasons.has(edit));
    const partitions = new Map<string | undefined, ExactFixEdit[]>();
    for (const edit of candidate.edits) {
      const reason = reasons.get(edit);
      const partition = partitions.get(reason);
      if (partition === undefined) partitions.set(reason, [edit]);
      else partition.push(edit);
    }
    for (const [reason, partition] of partitions) {
      itemDrafts.push(itemForExact(candidate, partition, reason));
    }
    if (edits.length > 0) {
      applicable.push(
        Object.freeze({ ...candidate, edits: Object.freeze(edits) }),
      );
    }
  }
  return Object.freeze({
    candidates: Object.freeze(applicable),
    items: finalizeItems(itemDrafts),
  });
}
