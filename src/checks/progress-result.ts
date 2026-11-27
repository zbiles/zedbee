import {
  INSTALLATION_MESSAGE,
  INSTALLATION_REMEDIATION,
} from "./installation-diagnostic.js";
import type { CheckResult } from "../core/types.js";
import { sanitizeCheckResult } from "./sanitize-result.js";

export function resultForProgress(result: CheckResult): CheckResult {
  return sanitizeCheckResult(
    result.error?.code === "COMPARISON_INSTALLATION_UNAVAILABLE"
      ? {
          ...result,
          error: {
            ...result.error,
            message: INSTALLATION_MESSAGE,
            remediation: INSTALLATION_REMEDIATION,
          },
        }
      : result,
  );
}
