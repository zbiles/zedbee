import { readFileSync, writeFileSync } from "node:fs";
import * as ts from "typescript";
import { creator } from "@secretlint/secretlint-rule-preset-recommend";
import { managedRuleInventory } from "../dist/checks/eslint/rule-settings.js";
import { structuralRules } from "../dist/checks/structural-security/rules.js";
import { DEPENDENCY_RULE_NAMES } from "../dist/checks/dependency-architecture/rules.js";

const catalog = {};
function add(check, rule, description = rule) {
  if (!/^[\x21-\x7e]{1,128}$/.test(rule))
    throw Error("Invalid package-owned rule ID");
  let label = String(description)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(/\{\d+\}/g, "…")
    .replace(/\s+/g, " ")
    .trim();
  while (Buffer.byteLength(label) > 96)
    label = Array.from(label).slice(0, -1).join("");
  (catalog[check] ??= {})[rule] = label || rule;
}
for (const check of ["lint", "reactCorrectness", "reactAccessibility"]) {
  for (const [id, rule] of managedRuleInventory(check))
    add(check, id, rule.meta?.docs?.description ?? id);
  add(check, "eslint/parsing-error", "Source could not be parsed");
  add(check, "eslint/unknown", "Unclassified bundled lint diagnostic");
}
for (const diagnostic of Object.values(ts.Diagnostics)) {
  if (Number.isSafeInteger(diagnostic.code))
    add("types", `typescript/TS${diagnostic.code}`, diagnostic.message);
}
for (const rule of structuralRules)
  add("structuralSecurity", rule.id, rule.message);
for (const id of Object.values(DEPENDENCY_RULE_NAMES))
  add("dependencyArchitecture", id);
for (const id of [
  "files",
  "dependencies",
  "devDependencies",
  "unlisted",
  "unresolved",
  "exports",
  "types",
  "nsExports",
  "nsTypes",
  "duplicates",
])
  add("deadCode", id, `Unused/dependency analysis: ${id}`);
for (const entry of Object.values(creator.rules)) {
  const rule = entry.rule ?? entry;
  if (rule.meta?.id)
    add("secrets", rule.meta.id, `Potential secret: ${rule.meta.id}`);
}
add("formatting", "prettier", "Formatting differs from configured style");
add(
  "cyclomaticComplexity",
  "cyclomatic-complexity",
  "Cyclomatic complexity exceeds its limit",
);
add(
  "readabilityComplexity",
  "readability-complexity",
  "Readability complexity exceeds its limit",
);
add("duplication", "duplicate-fragment", "Duplicated code fragment");
const sorted = Object.fromEntries(
  Object.keys(catalog)
    .sort()
    .map((check) => [
      check,
      Object.fromEntries(
        Object.entries(catalog[check]).sort(([a], [b]) =>
          a < b ? -1 : a > b ? 1 : 0,
        ),
      ),
    ]),
);
const output =
  "// Generated from bundled analyzer metadata; run telemetry:catalog:generate after build.\nexport const findingCatalog: Readonly<Record<string, Readonly<Record<string, string>>>> = " +
  JSON.stringify(sorted, null, 2) +
  ";\n";
const target = new URL("../src/telemetry/finding-catalog.ts", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(target, "utf8") !== output)
    throw Error("Telemetry finding catalog is stale");
} else writeFileSync(target, output);
