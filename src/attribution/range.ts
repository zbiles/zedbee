import type { Attribution, Finding } from "../core/types.js";
import type { ChangeSet } from "../git/change-set.js";

export const NO_ATTRIBUTION: Attribution = Object.freeze({
  kind: "none",
  staged: false,
  evidence: Object.freeze([]),
});

export function attributeByRange(
  finding: Finding,
  changeSet: ChangeSet,
): Finding {
  const location = finding.location;
  if (location === undefined || location.startLine === undefined) {
    return { ...finding, attribution: NO_ATTRIBUTION };
  }

  const startLine = location.startLine;
  const path = location.file.replaceAll("\\", "/");
  const endLine = location.endLine ?? startLine;
  const changedFile = changeSet.files.get(path);
  const overlap = changedFile?.addedRanges.find(
    (range) => startLine <= range.end && endLine >= range.start,
  );
  if (overlap === undefined) {
    return { ...finding, attribution: NO_ATTRIBUTION };
  }

  const overlapStart = Math.max(startLine, overlap.start);
  const overlapEnd = Math.min(endLine, overlap.end);
  return {
    ...finding,
    attribution: {
      kind: "range-overlap",
      staged: true,
      evidence: [
        `${path}:${startLine}-${endLine} overlaps staged lines ${overlapStart}-${overlapEnd}`,
      ],
    },
  };
}
