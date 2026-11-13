import type { ChangeSet } from "../git/change-set.js";
export type ChangeSummary = Readonly<{
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
}>;
export function summarizeChanges(changeSet: ChangeSet): ChangeSummary {
  const counts = { added: 0, modified: 0, deleted: 0, renamed: 0 };
  for (const file of changeSet.files.values()) counts[file.status]++;
  return Object.freeze(counts);
}
