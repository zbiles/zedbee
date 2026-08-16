# Structural security coverage

Zedbee ships a small, original set of high-confidence JavaScript and TypeScript
structural checks. They run locally against the exact Git-index snapshots and do
not load project code or download third-party rules.

| Rule                            | Reported structure                                                                           |
| ------------------------------- | -------------------------------------------------------------------------------------------- |
| `direct-eval`                   | A direct `eval(...)` call                                                                    |
| `function-constructor`          | `Function(...)` or `new Function(...)`                                                       |
| `child-process-string-exec`     | Imported Node `child_process.exec` or `execSync`                                             |
| `dynamic-vm-execution`          | Imported Node `vm.runInContext`, `runInNewContext`, or `runInThisContext`                    |
| `tls-verification-disabled`     | An object property setting `rejectUnauthorized` to `false`                                   |
| `weak-password-hash`            | An imported Node MD5 or SHA-1 `createHash` call directly updated with a password-named value |
| `credential-over-insecure-http` | Imported Node HTTP(S)/`request` options combining static HTTP with a present credential      |

These checks are intentionally narrower than Semgrep. They provide local AST
matching only: there is no dataflow or taint tracking, interfile analysis,
reachability analysis, framework rule pack, or continuously updated community
registry. In particular, aliases assigned after import and values assembled
across statements may not be detected. Zedbee should not be described as a
replacement for Semgrep Pro or an enterprise SAST platform.

For precision, global-looking APIs are ignored when their names are rebound in
the file. Request-option matching is limited to imports from Node's HTTP(S)
modules and the `request` package, and statically empty credential values are
ignored. These conservative boundaries can produce false negatives when aliases
are assembled dynamically.

Teams that need broader coverage can enable the separately managed Semgrep check
when that adapter is available. Keeping this built-in set original and bounded
also makes its behavior and licensing provenance straightforward to audit.
