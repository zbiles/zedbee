import { creator as recommendedPreset } from "@secretlint/secretlint-rule-preset-recommend";
import type { SecretLintCoreConfig } from "@secretlint/types";

export const SECRET_LINT_CONFIG: SecretLintCoreConfig = {
  rules: [
    {
      id: "@secretlint/secretlint-rule-preset-recommend",
      rule: recommendedPreset,
    },
  ],
};

Object.freeze(SECRET_LINT_CONFIG.rules[0]);
Object.freeze(SECRET_LINT_CONFIG.rules);
Object.freeze(SECRET_LINT_CONFIG);
