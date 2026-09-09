import type { CheckRunContext } from "../adapter.js";
import type { ChangedFile } from "../../git/change-set.js";
import { createFilePolicyResolver } from "../../config/file-policy.js";

export type SerializedCheckContext = Omit<
  CheckRunContext,
  "changeSet" | "policyForFile" | "signal"
> & {
  readonly changeSet: {
    readonly files: readonly (readonly [string, ChangedFile])[];
    readonly isEmpty: boolean;
  };
  /** The dispatcher scoped config differs from the authoritative per-file root policy. */
  readonly filePolicyConfig: CheckRunContext["config"];
};

export function serializeCheckContext(
  context: CheckRunContext,
): SerializedCheckContext {
  const {
    changeSet,
    signal: _signal,
    policyForFile: _policyForFile,
    ...rest
  } = context;
  return {
    ...rest,
    changeSet: { files: [...changeSet.files], isEmpty: changeSet.isEmpty },
    filePolicyConfig: context.filePolicyConfig ?? context.config,
  };
}

export function restoreCheckContext(
  input: SerializedCheckContext,
  signal: AbortSignal,
): CheckRunContext {
  const { filePolicyConfig, ...rest } = input;
  const files = new Map(input.changeSet.files);
  const changeSet = {
    files,
    isEmpty: input.changeSet.isEmpty,
    containsAddedLine(file: string, line: number) {
      return (
        files
          .get(file.replaceAll("\\", "/"))
          ?.addedRanges.some(
            (range) => line >= range.start && line <= range.end,
          ) ?? false
      );
    },
  };
  return {
    ...rest,
    changeSet,
    signal,
    policyForFile: createFilePolicyResolver(filePolicyConfig, changeSet),
    filePolicyConfig,
  };
}

let worker = false;
export function markAnalyzerWorker(): void {
  worker = true;
}
/** Nested CLI children stay inside the supervisor-owned process group. */
export function isAnalyzerWorker(): boolean {
  return worker;
}
