/**
 * Experimental programmatic API for Zedbee.
 *
 * The command-line interface is the supported v1 interface. These exports may
 * change between releases without the normal compatibility guarantees.
 *
 * @packageDocumentation
 * @experimental
 */
export { compareFindings, summarizeChecks } from "./core/summarize.js";
export { CHECK_IDS, PROFILE_IDS } from "./config/schema.js";
export type { CheckId, ProfileId } from "./config/schema.js";
export { DEFAULT_CHECK_ADAPTERS, runScan } from "./scan/run-scan.js";
export type { RunScanOptions } from "./scan/run-scan.js";
export type { ScanReport } from "./scan/report.js";
export type {
  Attribution,
  CheckError,
  CheckResult,
  CheckStatus,
  Finding,
  RunSummary,
  Severity,
  SourceLocation,
} from "./core/types.js";
