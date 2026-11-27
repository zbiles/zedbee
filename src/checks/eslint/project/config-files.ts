export const SUPPORTED_ESLINT_CONFIG_FILE_NAMES = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
] as const;

export const ESLINT_CONFIG_FILE_NAMES = [
  ...SUPPORTED_ESLINT_CONFIG_FILE_NAMES,
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc",
  ".eslintrc.json",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.yml",
  ".eslintrc.yaml",
] as const;
