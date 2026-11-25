import { renderFixPlanJson } from "../fixes/build-plan.js";
import {
  FIX_PLAN_FILE_SUMMARY_LIMIT,
  type PreparedFixPlan,
} from "../fixes/types.js";
import type {
  TemporaryReportStore,
  TemporaryReportResult,
} from "./temporary-reports.js";
import { COMPACT_DETAIL_LIMIT } from "./fix-presentation.js";
export async function maintainPlan(
  plan: PreparedFixPlan,
  store: TemporaryReportStore,
  persistCompletePlan: boolean,
  diagnostics = false,
): Promise<TemporaryReportResult> {
  const json =
    persistCompletePlan &&
    (plan.publicPlan.items.length > COMPACT_DETAIL_LIMIT ||
      plan.publicPlan.files.length > FIX_PLAN_FILE_SUMMARY_LIMIT)
      ? renderFixPlanJson(plan.publicPlan)
      : undefined;
  try {
    return await store.maintain({
      repositoryRoot: plan.repositoryRoot,
      maxAgeMs: plan.temporaryReportMaxAgeMs,
      reportKind: "fix-plan",
      ...(diagnostics ? { diagnostics: true } : {}),
      ...(json === undefined ? {} : { json }),
    });
  } catch {
    return {
      warnings: [
        {
          code: "TEMP_REPORT_WRITE_FAILED",
          message: "The temporary fix plan could not be maintained.",
        },
      ],
    };
  }
}
