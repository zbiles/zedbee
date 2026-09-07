import type { CheckId } from "../config/schema.js";
import type {
  CheckAdapter,
  CheckRunContext,
  InspectionContext,
} from "./adapter.js";
import type { Finding } from "../core/types.js";
import { CHECK_METADATA } from "./metadata.js";
import { inspectManagedCheck } from "./applicability.js";
import { runAnalyzerJob } from "./runner/run-job.js";
import { serializeCheckContext } from "./runner/context.js";
import { FIX_CHECKS } from "./runner/protocol.js";

/** The shipped default adapters are always proxies. Direct adapters are narrow
 * engine harnesses and injected dependencies, never a fallback for failed IPC. */
export function createManagedAdapters(
  run: typeof runAnalyzerJob = runAnalyzerJob,
): readonly CheckAdapter[] {
  return Object.freeze(
    (Object.keys(CHECK_METADATA) as CheckId[]).map((id): CheckAdapter => {
      const base = {
        id,
        inspect: (context: InspectionContext) =>
          inspectManagedCheck(id, context),
        ...(FIX_CHECKS.has(id)
          ? {
              planFixes: (
                context: CheckRunContext,
                findings: readonly Finding[],
              ) =>
                run(
                  {
                    version: 1,
                    checkId: id,
                    operation: "planFixes",
                    context: serializeCheckContext(context),
                    findings,
                  },
                  { signal: context.signal },
                ),
            }
          : {}),
      };
      if (id === "formatting")
        return Object.freeze({
          ...base,
          id,
          output: "legacy-check-result",
          runLegacy: (context: CheckRunContext) =>
            run(
              {
                version: 1,
                checkId: id,
                operation: "runLegacy",
                context: serializeCheckContext(context),
              },
              { signal: context.signal },
            ),
        });
      return Object.freeze({
        ...base,
        output: "observations",
        collect: (context: CheckRunContext) =>
          run(
            {
              version: 1,
              checkId: id,
              operation: "collect",
              context: serializeCheckContext(context),
            },
            { signal: context.signal },
          ),
      });
    }),
  );
}
export const DEFAULT_CHECK_ADAPTERS = createManagedAdapters();
