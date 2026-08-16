import { Linter, type Rule } from "eslint";

const functionTypes = new Set([
  "ArrowFunctionExpression",
  "FunctionDeclaration",
  "FunctionExpression",
]);

interface Frame {
  readonly node: Rule.Node;
  score: number;
  nesting: number;
}

function isFunction(node: Rule.Node): boolean {
  return functionTypes.has(node.type);
}

export const readabilityComplexityRule: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    schema: [],
    messages: { metric: "zedbee-readability:{{score}}" },
  },
  create(context) {
    const frames: Frame[] = [];
    const nested = new WeakSet<object>();
    const current = (): Frame | undefined => frames.at(-1);
    const enterDecision = (node: Rule.Node, addsNesting = true): void => {
      const frame = current();
      if (frame === undefined) return;
      const isElseIf =
        node.type === "IfStatement" &&
        node.parent?.type === "IfStatement" &&
        node.parent.alternate === node;
      frame.score +=
        1 + (isElseIf ? Math.max(0, frame.nesting - 1) : frame.nesting);
      if (addsNesting && !isElseIf) {
        frame.nesting += 1;
        nested.add(node);
      }
    };
    const exitDecision = (node: Rule.Node): void => {
      const frame = current();
      if (frame !== undefined && nested.has(node)) frame.nesting -= 1;
    };
    const logical = (node: Rule.Node): void => {
      const frame = current();
      if (frame === undefined || node.type !== "LogicalExpression") return;
      if (
        node.parent?.type !== "LogicalExpression" ||
        node.parent.operator !== node.operator
      ) {
        frame.score += 1;
      }
    };

    return {
      onCodePathStart(_codePath, node) {
        if (isFunction(node)) frames.push({ node, score: 0, nesting: 0 });
      },
      onCodePathEnd(_codePath, node) {
        if (!isFunction(node)) return;
        const frame = frames.pop();
        if (frame === undefined || frame.node !== node) {
          throw new Error("Readability complexity traversal became unbalanced");
        }
        context.report({
          node,
          messageId: "metric",
          data: { score: frame.score },
        });
      },
      IfStatement: enterDecision,
      "IfStatement:exit": exitDecision,
      ForStatement: enterDecision,
      "ForStatement:exit": exitDecision,
      ForInStatement: enterDecision,
      "ForInStatement:exit": exitDecision,
      ForOfStatement: enterDecision,
      "ForOfStatement:exit": exitDecision,
      WhileStatement: enterDecision,
      "WhileStatement:exit": exitDecision,
      DoWhileStatement: enterDecision,
      "DoWhileStatement:exit": exitDecision,
      SwitchStatement: enterDecision,
      "SwitchStatement:exit": exitDecision,
      CatchClause: enterDecision,
      "CatchClause:exit": exitDecision,
      ConditionalExpression: enterDecision,
      "ConditionalExpression:exit": exitDecision,
      LogicalExpression: logical,
    };
  },
};

export function scoreReadabilityComplexities(source: string): number[] {
  const linter = new Linter({ configType: "flat" });
  const messages = linter.verify(source, [
    {
      languageOptions: { ecmaVersion: "latest", sourceType: "module" },
      plugins: {
        zedbee: { rules: { readability: readabilityComplexityRule } },
      },
      rules: { "zedbee/readability": "error" },
    },
  ]);
  return messages.flatMap((message) => {
    const matched = /^zedbee-readability:(\d+)$/u.exec(message.message);
    return matched === null ? [] : [Number(matched[1])];
  });
}

export function scoreReadabilityComplexity(source: string): number {
  const scores = scoreReadabilityComplexities(source);
  if (scores.length !== 1)
    throw new Error("Expected exactly one function complexity metric");
  return scores[0]!;
}
