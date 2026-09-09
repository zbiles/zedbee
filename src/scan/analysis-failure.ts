import { ConfigError } from "../config/load-config.js";
import {
  BaseComparisonError,
  type BaseComparisonErrorCode,
} from "../git/base-comparison.js";
import { GitCommandError } from "../git/errors.js";
import { SnapshotError } from "../git/snapshot.js";
import type { ScanMode } from "./source-mode.js";
import type { ScanFailureInput } from "./incomplete-report.js";

/** Keeps safe diagnoses together without losing the original internal cause. */
export class AnalysisSessionCleanupError extends Error {
  readonly temporaryPath?: string;
  readonly primaryFailure?: ScanFailureInput;

  constructor(
    temporaryPath?: string,
    primary?: { cause: unknown; primaryFailure: ScanFailureInput },
  ) {
    super(
      "Zedbee could not remove its temporary snapshot.",
      primary === undefined ? undefined : { cause: primary.cause },
    );
    this.name = "AnalysisSessionCleanupError";
    if (temporaryPath !== undefined) this.temporaryPath = temporaryPath;
    if (primary !== undefined) this.primaryFailure = primary.primaryFailure;
  }
}

/** Cancellation keeps its identity when possible, with a non-enumerable safe cleanup diagnosis. */
export function retainCleanupFailure(
  error: unknown,
  cleanup: AnalysisSessionCleanupError,
): unknown {
  if (error instanceof Error && Object.isExtensible(error)) {
    try {
      Object.defineProperty(error, "cleanupFailure", {
        value: cleanup,
        configurable: true,
      });
      return error;
    } catch {
      // Frozen or custom error objects still retain their identity as the cause.
    }
  }
  return cleanup;
}

/** Inspect only the explicit cleanup attachment, never exception causes or messages. */
export function hasAnalysisCleanupFailure(error: unknown): boolean {
  if (error instanceof AnalysisSessionCleanupError) return true;
  if (!(error instanceof Error)) return false;
  const descriptor = Object.getOwnPropertyDescriptor(error, "cleanupFailure");
  return (
    descriptor !== undefined &&
    "value" in descriptor &&
    descriptor.value instanceof AnalysisSessionCleanupError
  );
}

export type ActiveScanPhase =
  | "configuration"
  | "change-discovery"
  | "baseline-resolution"
  | "snapshot-construction"
  | "baseline-inspection"
  | "target-inspection"
  | "dispatch"
  | "policy-evaluation";

const PHASE_FAILURES = {
  configuration: {
    code: "CONFIGURATION_FAILED",
    message: "Zedbee could not load the configuration.",
    remediation: "Check the Zedbee configuration and run the scan again.",
  },
  "change-discovery": {
    code: "CHANGE_DISCOVERY_FAILED",
    message: "Zedbee could not read the staged changes.",
    remediation: "Resolve the Git index problem and run the scan again.",
  },
  "baseline-resolution": {
    code: "BASELINE_RESOLUTION_FAILED",
    message: "Zedbee could not resolve the repository baseline.",
    remediation: "Check the Git repository state and run the scan again.",
  },
  "snapshot-construction": {
    code: "SNAPSHOT_CONSTRUCTION_FAILED",
    message: "Zedbee could not construct the staged snapshots.",
    remediation:
      "Check the Git index and temporary-directory permissions, then retry.",
  },
  "baseline-inspection": {
    code: "BASELINE_INSPECTION_FAILED",
    message: "Zedbee could not inspect the baseline snapshot.",
    remediation:
      "Check the baseline repository metadata and run the scan again.",
  },
  "target-inspection": {
    code: "TARGET_INSPECTION_FAILED",
    message: "Zedbee could not inspect the staged snapshot.",
    remediation: "Check the staged repository metadata and run the scan again.",
  },
  dispatch: {
    code: "CHECK_DISPATCH_FAILED",
    message: "Zedbee could not dispatch the configured checks.",
    remediation: "Review the check diagnostics, run zedbee doctor, and retry.",
  },
  "policy-evaluation": {
    code: "POLICY_EVALUATION_FAILED",
    message: "Zedbee could not evaluate the scan policy.",
    remediation: "Check the Zedbee policy configuration and retry.",
  },
} as const satisfies Readonly<Record<ActiveScanPhase, ScanFailureInput>>;

const BASE_COMPARISON_FAILURES: Readonly<
  Record<BaseComparisonErrorCode, ScanFailureInput>
> = {
  BASE_REF_INVALID: {
    code: "BASE_REF_INVALID",
    message: "Zedbee refused an invalid requested base ref.",
    remediation:
      "Choose a non-empty display-safe base ref that does not begin with '-', then retry.",
  },
  BASE_REF_UNAVAILABLE: {
    code: "BASE_REF_UNAVAILABLE",
    message: "Zedbee could not resolve the requested base ref locally.",
    remediation:
      "Fetch the requested base ref or choose one available locally, then retry.",
  },
  TARGET_COMMIT_UNAVAILABLE: {
    code: "TARGET_COMMIT_UNAVAILABLE",
    message: "Zedbee could not resolve the target commit.",
    remediation: "Check out or create a valid target commit, then retry.",
  },
  MERGE_BASE_UNAVAILABLE: {
    code: "MERGE_BASE_UNAVAILABLE",
    message: "Zedbee could not find a merge base for the selected revisions.",
    remediation:
      "Fetch enough local history for both revisions or choose a base with shared history, then retry.",
  },
  MERGE_BASE_AMBIGUOUS: {
    code: "MERGE_BASE_AMBIGUOUS",
    message:
      "Zedbee found more than one merge base for the selected revisions.",
    remediation: "Choose a base with one unambiguous merge base, then retry.",
  },
  REVISION_OUTPUT_INVALID: {
    code: "REVISION_OUTPUT_INVALID",
    message: "Zedbee received invalid revision data from Git.",
    remediation:
      "Verify the local Git repository and Git executable, then retry.",
  },
};

function sourcePhaseFailure(
  phase: ActiveScanPhase,
  mode: ScanMode,
): ScanFailureInput {
  if (mode === "index") return PHASE_FAILURES[phase];
  if (phase === "change-discovery") {
    return {
      code: "CHANGE_DISCOVERY_FAILED",
      message: "Zedbee could not read the committed changes.",
      remediation:
        "Verify the selected commits and local Git objects, then retry.",
    };
  }
  if (phase === "snapshot-construction") {
    return {
      code: "SNAPSHOT_CONSTRUCTION_FAILED",
      message: "Zedbee could not construct the committed snapshots.",
      remediation:
        "Verify the selected commits, local Git objects, and temporary-directory permissions, then retry.",
    };
  }
  if (phase === "target-inspection") {
    return {
      code: "TARGET_INSPECTION_FAILED",
      message: "Zedbee could not inspect the committed target snapshot.",
      remediation:
        "Check the committed target repository metadata and run the scan again.",
    };
  }
  return PHASE_FAILURES[phase];
}

export function phaseFailure(
  error: unknown,
  phase: ActiveScanPhase,
  mode: ScanMode,
): ScanFailureInput {
  if (error instanceof BaseComparisonError) {
    return BASE_COMPARISON_FAILURES[error.code];
  }
  if (error instanceof GitCommandError) {
    if (error.code === "GIT_OUTPUT_LIMIT_EXCEEDED") {
      return {
        code: error.code,
        message:
          "Zedbee stopped a Git command after it exceeded the configured output limit.",
        remediation:
          "Increase resources.git.outputLimitBytes and run the scan again.",
      };
    }
    if (error.code === "GIT_HARD_TIMEOUT") {
      return {
        code: error.code,
        message:
          "Zedbee stopped a Git command after it exceeded the configured hard timeout.",
        remediation:
          "Increase resources.git.hardTimeout or run zedbee scan with --no-timeout.",
      };
    }
  }
  if (phase === "configuration" && error instanceof ConfigError) {
    return error.code === "CONFIG_UNSUPPORTED"
      ? {
          code: error.code,
          message: "Zedbee found an unsupported configuration file.",
          remediation:
            "Replace it with .zedbeerc.jsonc and run the scan again.",
        }
      : {
          code: error.code,
          message: "Zedbee could not load a valid configuration.",
          remediation: "Fix the Zedbee configuration and run the scan again.",
        };
  }
  if (phase === "snapshot-construction" && error instanceof SnapshotError) {
    if (error.code === "UNRESOLVED_INDEX" && mode === "index") {
      return {
        code: error.code,
        message: "Zedbee cannot scan an index with unresolved entries.",
        remediation: "Resolve the staged merge entries and run the scan again.",
      };
    }
    if (error.code === "INVALID_INDEX_PATH") {
      return mode === "index"
        ? {
            code: error.code,
            message: "Zedbee refused an invalid staged repository path.",
            remediation:
              "Repair or remove the invalid Git index entry and run the scan again.",
          }
        : {
            code: error.code,
            message: "Zedbee refused an invalid committed repository path.",
            remediation:
              "Choose a committed target without the invalid repository path, then retry.",
          };
    }
    if (error.code === "INVALID_TEMP_PATH") {
      return {
        code: error.code,
        message: "Zedbee refused an unsafe temporary snapshot path.",
        remediation:
          "Verify the system temporary directory and run the scan again.",
      };
    }
    return sourcePhaseFailure(phase, mode);
  }
  return sourcePhaseFailure(phase, mode);
}
