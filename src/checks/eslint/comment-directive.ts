import type { ESLint, Rule } from "eslint";
import tseslint from "typescript-eslint";

function possibleBlockDirective(value: string): boolean {
  const lastBreak = Math.max(
    value.lastIndexOf("\n"),
    value.lastIndexOf("\r"),
    value.lastIndexOf("\u2028"),
    value.lastIndexOf("\u2029"),
  );
  const prefix = value
    .slice(lastBreak + 1)
    .trimStart()
    .replace(/^[/*]*/u, "")
    .trimStart();
  return (
    prefix.startsWith("@ts-ignore") || prefix.startsWith("@ts-expect-error")
  );
}

const plugin = tseslint.plugin as unknown as ESLint.Plugin;
const original = plugin.rules!["ban-ts-comment"]!;
const rule: Rule.RuleModule = {
  ...original,
  create(context) {
    // The pinned rule's overlapping whitespace regex is quadratic on negative
    // block comments. This equivalent linear predicate only narrows that rule's
    // input. Upstream still owns recognition, options, reporting and suggestions;
    // source text and the original comment nodes/ranges remain unchanged.
    const sourceCode = Object.create(context.sourceCode, {
      getAllComments: {
        value: () =>
          context.sourceCode
            .getAllComments()
            .filter(
              (comment) =>
                comment.type !== "Block" ||
                possibleBlockDirective(comment.value),
            ),
      },
    }) as Rule.RuleContext["sourceCode"];
    return original.create(
      Object.create(context, {
        sourceCode: { value: sourceCode },
        getSourceCode: { value: () => sourceCode },
      }) as Rule.RuleContext,
    );
  },
};

// Never mutate the shared upstream plugin or its presets.
export const managedTypescriptPlugin: ESLint.Plugin = Object.freeze({
  ...plugin,
  rules: Object.freeze({ ...plugin.rules, "ban-ts-comment": rule }),
});
