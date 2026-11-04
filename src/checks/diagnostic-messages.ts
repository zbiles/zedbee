import type { CheckObservationSet } from "./adapter.js";
import type { Observation } from "../core/types.js";

const SOURCE_BEARING_MESSAGES = new Set([
  "types",
  "lint",
  "reactCorrectness",
  "reactAccessibility",
]);

/** Revalidate old/custom cache prose as well as freshly collected diagnostics. */
export function createDiagnosticMessageSanitizer() {
  const messages = new Map<string, string>();
  const sanitize = async (observation: Observation): Promise<Observation> => {
    if (
      typeof observation?.message !== "string" ||
      typeof observation.rule !== "string"
    )
      return observation;
    const key = JSON.stringify([
      observation.check,
      observation.rule,
      observation.message,
    ]);
    let message = messages.get(key);
    if (message === undefined) {
      if (observation.check === "types") {
        const { typescriptDiagnosticMessage } =
          await import("./typescript/convert-diagnostic.js");
        const code = /^typescript\/TS(\d+)$/u.exec(observation.rule)?.[1];
        message = typescriptDiagnosticMessage(
          code === undefined ? -1 : Number(code),
        );
      } else {
        const { eslintDiagnosticMessage } =
          await import("./eslint/convert-message.js");
        message = eslintDiagnosticMessage(
          observation.rule,
          observation.check,
          observation.message,
        );
      }
      if (messages.size >= 256) messages.delete(messages.keys().next().value!);
      messages.set(key, message);
    }
    return { ...observation, message };
  };
  return async (set: CheckObservationSet): Promise<CheckObservationSet> => {
    if (
      !SOURCE_BEARING_MESSAGES.has(set?.checkId) ||
      !Array.isArray(set.baselineObservations) ||
      !Array.isArray(set.targetObservations)
    )
      return set;
    const baselineObservations: Observation[] = [];
    const targetObservations: Observation[] = [];
    for (const observation of set.baselineObservations)
      baselineObservations.push(await sanitize(observation));
    for (const observation of set.targetObservations)
      targetObservations.push(await sanitize(observation));
    return { ...set, baselineObservations, targetObservations };
  };
}
