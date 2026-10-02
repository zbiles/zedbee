import { ESLint } from "eslint";
import "../../../../src/checks/runner/worker.ts";

const lintText = ESLint.prototype.lintText;
ESLint.prototype.lintText = async function (source, options) {
  if (!options?.filePath?.endsWith("second.ts"))
    return lintText.call(this, source, options);
  const error = new TypeError(
    "Cannot read properties of undefined (reading 'some')\nfixture-secret-source-marker",
  );
  error.ruleId = "@typescript-eslint/no-misused-promises";
  error.stack =
    "TypeError: fixture-secret-source-marker\n    at hasWellKnownSymbolWithVoidReturn (/private/fixture/node_modules/@typescript-eslint/eslint-plugin/dist/rules/no-misused-promises.js:123:45)";
  throw error;
};
