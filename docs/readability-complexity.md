# Zedbee Readability Complexity

> **Migration warning:** Zedbee Readability Complexity is an original metric. It is not Sonar Cognitive Complexity and does not claim score parity. Teams migrating from Sonar will see different numbers and must recalibrate their thresholds before blocking commits.

Zedbee reports one readability score for every function, method, constructor,
accessor, and arrow or function expression. Function boundaries reset both the
score and nesting depth, so a nested function never increases its owner's
score.

## Scoring contract

- A decision contributes `1 + current decision nesting`.
- `if`, loops, `switch`, `catch`, and conditional (`?:`) expressions are
  decisions.
- An `else if` contributes one decision without inheriting an extra nesting
  level from the preceding `if`.
- Each contiguous same-operator logical segment contributes one. Changing from
  `&&` to `||` starts another segment.

These examples are normative:

- `function f(){ if (a) { if (b) work(); } }` scores **3**: the outer
  decision adds 1 and the nested decision adds 2.
- `function f(){ return a && b || c; }` scores **2**: the `&&` and `||`
  segments each add 1.
- `function f(){ try { work(); } catch { recover(); } }` scores **1**: the
  catch path adds 1.

Cyclomatic complexity is a separate metric produced by ESLint's core
`complexity` rule. Zedbee compares the complete baseline and staged values for
the same canonical syntax entity. Central attribution reports a blocking
finding only when the entity intersects the staged change and the configured
limit policy says the metric crossed or worsened above its threshold. Existing
debt and metrics on unchanged entities remain visible as unstaged observations,
not commit-blocking findings.
