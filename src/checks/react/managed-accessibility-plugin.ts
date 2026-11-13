import { createRequire } from "node:module";
import type { ESLint, Rule } from "eslint";

const require = createRequire(import.meta.url);
function upstreamPlugin() {
  return require("eslint-plugin-jsx-a11y") as ESLint.Plugin & {
    rules: Record<string, Rule.RuleModule>;
    flatConfigs: { recommended: { rules: Record<string, unknown> } };
  };
}

type Syntax = {
  type: string;
  value?: unknown;
  name?: string | Syntax;
  argument?: Syntax;
  operator?: string;
  expression?: Syntax;
  attributes?: Syntax[];
};
function literal(node: Syntax | undefined): unknown {
  if (node?.type === "JSXExpressionContainer") return literal(node.expression);
  if (node?.type === "Literal") return node.value;
  if (
    node?.type === "UnaryExpression" &&
    node.operator === "-" &&
    typeof node.argument?.value === "number"
  )
    return -node.argument.value;
  return undefined;
}
/** jsx-a11y 6.10.2 models separator only as structure, despite ARIA's focusable widget form. */
function isWindowSplitter(node: Syntax): boolean {
  const attributes = new Map<string, Syntax>();
  for (const attribute of node.attributes ?? []) {
    // A spread can override every earlier attribute. Later explicit values restore certainty.
    if (attribute.type === "JSXSpreadAttribute") attributes.clear();
    else if (
      typeof attribute.name === "object" &&
      typeof attribute.name.name === "string"
    )
      attributes.set(attribute.name.name, attribute);
  }
  const role = literal(attributes.get("role")?.value as Syntax | undefined);
  // Only a literal separator is proven; role fallback lists require knowing supported tokens.
  if (role !== "separator") return false;
  const index = literal(
    attributes.get("tabIndex")?.value as Syntax | undefined,
  );
  if (
    !(typeof index === "number" || typeof index === "string") ||
    String(index).trim() === "" ||
    !Number.isInteger(Number(index))
  )
    return false;
  const value = attributes.get("aria-valuenow")?.value as Syntax | undefined;
  if (value === undefined) return false;
  const expression =
    value.type === "JSXExpressionContainer" ? value.expression : value;
  if (expression?.type === "Literal")
    return (
      (typeof expression.value === "number" &&
        Number.isFinite(expression.value)) ||
      (typeof expression.value === "string" &&
        expression.value.trim() !== "" &&
        Number.isFinite(Number(expression.value)))
    );
  return (
    expression !== undefined &&
    !(
      expression.type === "UnaryExpression" && expression.operator === "void"
    ) &&
    !(expression.type === "Identifier" && expression.name === "undefined")
  );
}
function corrected(rule: Rule.RuleModule): Rule.RuleModule {
  return {
    ...rule,
    create(context) {
      const listeners = rule.create(context);
      const opening = listeners.JSXOpeningElement as
        ((node: Rule.Node) => void) | undefined;
      return {
        ...listeners,
        JSXOpeningElement(node: Rule.Node) {
          if (!isWindowSplitter(node as unknown as Syntax)) opening?.(node);
        },
      };
    },
  };
}
let cached: ReturnType<typeof upstreamPlugin> | undefined;
export function managedAccessibilityPlugin() {
  if (cached !== undefined) return cached;
  const upstream = upstreamPlugin();
  return (cached = {
    ...upstream,
    rules: {
      ...upstream.rules,
      ...Object.fromEntries(
        [
          "no-noninteractive-element-interactions",
          "no-noninteractive-tabindex",
        ].map((name) => [name, corrected(upstream.rules[name]!)]),
      ),
    },
  });
}
