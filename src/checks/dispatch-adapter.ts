import { displayLabel, displayProse } from "../core/display-text.js";
import { compareCodeUnits } from "../core/compare.js";
import type {
  CheckAdapter,
  CheckApplicability,
  CheckTarget,
  ObservationCheckAdapter,
  LegacyCheckResultAdapter,
  CheckFixProvider,
} from "./adapter.js";
import { sanitizeCheckTarget } from "./sanitize-target.js";

export type AdapterSnapshot =
  | Readonly<{
      id: string;
      output: "observations";
      inspect: ObservationCheckAdapter["inspect"];
      collect: ObservationCheckAdapter["collect"];
      planFixes?: CheckFixProvider;
    }>
  | Readonly<{
      id: "formatting";
      output: "legacy-check-result";
      inspect: LegacyCheckResultAdapter["inspect"];
      runLegacy: LegacyCheckResultAdapter["runLegacy"];
      planFixes?: CheckFixProvider;
    }>;

type AdapterSnapshotResult =
  | Readonly<{ valid: true; adapter: AdapterSnapshot }>
  | Readonly<{ valid: false; id: string }>;

function adapterId(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.trim() !== value ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("Adapter returned an invalid check id");
  }
  return displayLabel(value, "adapter check id");
}

export function snapshotAdapter(raw: CheckAdapter): AdapterSnapshotResult {
  const candidate = raw as unknown as Record<string, unknown>;
  let id = "unknown";
  try {
    id = adapterId(candidate.id);
    const output = candidate.output;
    const inspect = candidate.inspect;
    const planFixes = candidate.planFixes;
    if (typeof inspect !== "function") {
      throw new TypeError("Adapter returned an invalid inspect function");
    }
    if (planFixes !== undefined && typeof planFixes !== "function") {
      throw new TypeError("Adapter returned an invalid fix provider");
    }
    const inspectFunction = inspect as ObservationCheckAdapter["inspect"];
    if (output === "observations") {
      const collect = candidate.collect;
      if (typeof collect !== "function") {
        throw new TypeError("Adapter returned an invalid collect function");
      }
      return Object.freeze({
        valid: true,
        adapter: Object.freeze({
          id,
          output,
          inspect: inspectFunction,
          collect: collect as ObservationCheckAdapter["collect"],
          ...(planFixes === undefined
            ? {}
            : { planFixes: planFixes as CheckFixProvider }),
        }),
      });
    }
    if (output === "legacy-check-result" && id === "formatting") {
      const runLegacy = candidate.runLegacy;
      if (typeof runLegacy !== "function") {
        throw new TypeError("Adapter returned an invalid legacy function");
      }
      return Object.freeze({
        valid: true,
        adapter: Object.freeze({
          id,
          output,
          inspect: inspectFunction,
          runLegacy: runLegacy as LegacyCheckResultAdapter["runLegacy"],
          ...(planFixes === undefined
            ? {}
            : { planFixes: planFixes as CheckFixProvider }),
        }),
      });
    }
    throw new TypeError("Adapter returned an invalid output contract");
  } catch {
    return Object.freeze({ valid: false, id });
  }
}

export function snapshotApplicability(value: unknown): CheckApplicability {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("Adapter returned invalid applicability");
  }
  const candidate = value as Record<string, unknown>;
  const applies = candidate.applies;
  if (applies === false) {
    const reason = candidate.reason;
    if (
      typeof reason !== "string" ||
      reason.length === 0 ||
      reason.trim() !== reason ||
      /[\u0000-\u001f\u007f]/u.test(reason)
    ) {
      throw new TypeError("Adapter returned an invalid skip reason");
    }
    return Object.freeze({
      applies,
      reason: displayProse(reason, "skip reason"),
    });
  }
  if (applies !== true) {
    throw new TypeError("Adapter returned invalid applicability");
  }
  const executionClass = candidate.executionClass;
  const requiresBaseline = candidate.requiresBaseline;
  const rawTargets = candidate.targets;
  const rawDisclosure = candidate.networkDisclosure;
  if (
    (executionClass !== "lightweight" &&
      executionClass !== "project-analysis" &&
      executionClass !== "network") ||
    typeof requiresBaseline !== "boolean" ||
    !Array.isArray(rawTargets)
  ) {
    throw new TypeError("Adapter returned invalid applicability");
  }
  const targets = Object.freeze(
    rawTargets
      .map((target) => sanitizeCheckTarget(target as CheckTarget))
      .sort((left, right) => compareCodeUnits(left.id, right.id)),
  );
  let networkDisclosure:
    | {
        readonly services: readonly string[];
        readonly metadata: readonly string[];
      }
    | undefined;
  if (rawDisclosure !== undefined) {
    if (
      executionClass !== "network" ||
      typeof rawDisclosure !== "object" ||
      rawDisclosure === null
    ) {
      throw new TypeError("Adapter returned invalid network disclosure");
    }
    const disclosure = rawDisclosure as Record<string, unknown>;
    if (
      !Array.isArray(disclosure.services) ||
      !Array.isArray(disclosure.metadata)
    ) {
      throw new TypeError("Adapter returned invalid network disclosure");
    }
    const services = Object.freeze(
      disclosure.services.map((service) =>
        displayProse(service, "network service"),
      ),
    );
    const metadata = Object.freeze(
      disclosure.metadata.map((field) =>
        displayProse(field, "network metadata"),
      ),
    );
    if (services.length === 0 || metadata.length === 0) {
      throw new TypeError("Adapter returned invalid network disclosure");
    }
    networkDisclosure = Object.freeze({ services, metadata });
  }
  return Object.freeze({
    applies,
    executionClass,
    requiresBaseline,
    targets,
    ...(networkDisclosure === undefined ? {} : { networkDisclosure }),
  });
}
