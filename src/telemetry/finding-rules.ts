import { findingCatalog } from "./finding-catalog.js";

const advisory =
  /^(?:GHSA-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}-[23456789cfghjmpqrvwx]{4}|CVE-[0-9]{4}-[0-9]{4,})$/u;
export function findingLabel(
  checkId: string,
  ruleId: string,
): string | undefined {
  if (!/^[\x21-\x7e]{1,128}$/u.test(ruleId)) return undefined;
  if (checkId === "vulnerabilities" && advisory.test(ruleId))
    return "Public vulnerability advisory";
  if (!Object.hasOwn(findingCatalog, checkId)) return undefined;
  const rules = findingCatalog[checkId]!;
  return Object.hasOwn(rules, ruleId) ? rules[ruleId] : undefined;
}
export function allowedFindingRule(checkId: string, ruleId: string): boolean {
  return findingLabel(checkId, ruleId) !== undefined;
}
