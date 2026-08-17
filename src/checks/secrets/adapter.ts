import { randomBytes } from "node:crypto";
import { lintSource } from "@secretlint/core";
import type { SecretLintCoreResult } from "@secretlint/types";
import type {
  CheckObservationSet,
  CheckRunContext,
  InspectionContext,
  ObservationCheckAdapter,
} from "../adapter.js";
import { CheckIncompleteError } from "../incomplete-error.js";
import type { Observation } from "../../core/types.js";
import { SECRET_LINT_CONFIG } from "./config.js";
import {
  collectSecretSourcePairs,
  SecretContentError,
  type SecretTextSource,
} from "./content.js";
import { normalizeSecretlintMessages } from "./normalize.js";

const TARGET = Object.freeze({
  id: ".",
  kind: "repository" as const,
  relativeRoot: ".",
});

export interface SecretsAdapterDependencies {
  readonly lintSource: typeof lintSource;
  readonly comparisonKey: () => Uint8Array;
}

const defaults: SecretsAdapterDependencies = {
  lintSource,
  comparisonKey: () => randomBytes(32),
};

async function lintText(
  source: SecretTextSource,
  comparisonKey: Uint8Array,
  dependencies: SecretsAdapterDependencies,
): Promise<readonly Observation[]> {
  let result: SecretLintCoreResult | undefined = await dependencies.lintSource({
    source: {
      content: source.content,
      filePath: source.reportPath,
      contentType: "text",
    },
    options: {
      config: SECRET_LINT_CONFIG,
      maskSecrets: true,
      noPhysicFilePath: true,
    },
  });
  const observations = normalizeSecretlintMessages({
    messages: result.messages,
    source: source.content,
    reportPath: source.reportPath,
    identityPath: source.identityPath,
    comparisonKey,
  });
  result = undefined;
  return observations;
}

function safeIncomplete(error: unknown): CheckIncompleteError {
  if (error instanceof SecretContentError) {
    return new CheckIncompleteError({
      code: error.code,
      message: error.message,
      path: error.path,
      remediation: error.remediation,
    });
  }
  return new CheckIncompleteError({
    code: "SECRETLINT_ANALYSIS_FAILED",
    message: "Secret analysis could not be completed safely.",
    remediation: "Run zedbee doctor, update Zedbee, and retry the scan.",
  });
}

export function createSecretsAdapter(
  dependencies: SecretsAdapterDependencies = defaults,
): ObservationCheckAdapter {
  return Object.freeze({
    id: "secrets",
    output: "observations" as const,
    async inspect(context: InspectionContext) {
      const changedFiles = [...context.changeSet.files.values()].filter(
        ({ status }) => status !== "deleted",
      );
      if (changedFiles.length === 0) {
        return { applies: false as const, reason: "No staged files to scan" };
      }
      return {
        applies: true as const,
        executionClass: "project-analysis" as const,
        requiresBaseline: true,
        targets: [TARGET],
      };
    },
    async collect(context: CheckRunContext): Promise<CheckObservationSet> {
      try {
        const pairs = await collectSecretSourcePairs(context);
        const comparisonKey = dependencies.comparisonKey();
        const baselineObservations: Observation[] = [];
        const targetObservations: Observation[] = [];
        for (const pair of pairs) {
          if (context.signal.aborted) {
            throw new Error("Secret analysis aborted");
          }
          if (pair.baseline !== undefined) {
            baselineObservations.push(
              ...(await lintText(pair.baseline, comparisonKey, dependencies)),
            );
          }
          if (pair.target !== undefined) {
            targetObservations.push(
              ...(await lintText(pair.target, comparisonKey, dependencies)),
            );
          }
        }
        return {
          checkId: "secrets",
          target: context.target,
          baselineObservations: Object.freeze(baselineObservations),
          targetObservations: Object.freeze(targetObservations),
        };
      } catch (error) {
        throw safeIncomplete(error);
      }
    },
  });
}

export const secretsAdapter = createSecretsAdapter();
