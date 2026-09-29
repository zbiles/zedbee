import { isDeepStrictEqual } from "node:util";
import { resolveConfig } from "./profiles.js";
import {
  CHECK_IDS,
  type CheckId,
  type ProfileId,
  type ResolvedConfig,
} from "./schema.js";

/** Bounded policy metadata; never includes configuration paths or settings. */
export interface ConfigurationSummary {
  readonly profile: ProfileId | "custom";
  /** Enabled anywhere in configured policy, independent of this scan's input. */
  readonly enabledCheckIds: readonly CheckId[];
}

export function summarizeConfiguration(
  config: ResolvedConfig,
): ConfigurationSummary {
  const builtIn = resolveConfig({ schemaVersion: 1, profile: config.profile });
  const customized =
    config.overrides.length > 0 ||
    config.pathExclusions.length > 0 ||
    !isDeepStrictEqual(config.checks, builtIn.checks);
  return Object.freeze({
    profile: customized ? "custom" : config.profile,
    enabledCheckIds: Object.freeze(
      CHECK_IDS.filter(
        (id) =>
          config.checks[id].severity !== "off" ||
          config.overrides.some((override) => {
            const severity = override.checks[id]?.severity;
            return severity !== undefined && severity !== "off";
          }),
      ),
    ),
  });
}
