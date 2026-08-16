# Checks

Zedbee owns the analyzer versions and inert configuration used by every v1 check. `relevant` checks run when staged state can affect them; `always` checks run whenever their required project inputs exist. Analysis scope may be broader than the changed lines, while attribution still blocks only new or worsened staged responsibility.

| Check ID                 | Coverage                                                    | Scope and attribution                                                                                                 | Important limitation                                                                                  |
| ------------------------ | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `formatting`             | Prettier formatting                                         | Transforms staged target files and intersects formatting changes with added lines                                     | Reports only; v1 never applies fixes                                                                  |
| `lint`                   | ESLint, typescript-eslint, and managed correctness rules    | Compares workspace diagnostics and attributes locations/entities                                                      | Does not load project ESLint plugins or executable config                                             |
| `types`                  | TypeScript diagnostics                                      | Compares isolated baseline/target programs for each workspace                                                         | TypeScript source requires a contained staged `tsconfig.json`                                         |
| `cyclomaticComplexity`   | Branch-path complexity                                      | Compares changed syntax entities against `max` and worsening policy                                                   | Thresholds require team calibration                                                                   |
| `readabilityComplexity`  | Zedbee's original nesting/readability metric                | Compares changed syntax entities against `max` and worsening policy                                                   | It is not Sonar Cognitive Complexity and scores are not interchangeable                               |
| `structuralSecurity`     | Managed ast-grep rules for high-confidence local patterns   | Compares rule/location observations in JavaScript and TypeScript source                                               | Narrower than Semgrep; no general taint, dataflow, reachability, interfile, or live registry coverage |
| `secrets`                | Gitleaks 8.28.0 canonical rules                             | Compares redacted baseline/target locations; an ephemeral keyed source-range digest detects same-location replacement | Scans snapshot content, not Git history; unsupported platforms are incomplete                         |
| `duplication`            | jscpd clone detection and repository duplication percentage | Compares whole workspaces and attributes new clone regions/project regressions                                        | Large source lists can exceed an operating-system argument limit                                      |
| `dependencyArchitecture` | Dependency Cruiser cycles and invalid dependency edges      | Compares the workspace module graph                                                                                   | Uses managed rules, not a project's executable dependency-cruiser config                              |
| `deadCode`               | Knip unused files, exports, and dependency hygiene          | Compares each workspace as a project                                                                                  | Framework plugins are disabled; dynamic conventions and aliases can require future managed profiles   |
| `reactCorrectness`       | React, Hooks, and JSX correctness                           | Runs only in discovered React/Ink/Next/Remix workspaces                                                               | Fixed React 19.2 rule setting can be less exact for other React versions                              |
| `reactAccessibility`     | React DOM JSX accessibility                                 | Runs only for React DOM, Next.js, and Remix—not Ink terminal UI                                                       | Static JSX rules cannot prove runtime accessibility                                                   |
| `vulnerabilities`        | OSV-Scanner 2.4.0 advisory comparison                       | Compares advisory/package/dependency-path state when lockfiles change or timing is `always`                           | Online mode discloses package metadata; strict offline mode requires a pre-populated local database   |

## Profiles

- `fast`: local formatting, lint, complexity, structural security, and applicable React checks.
- `recommended`: `fast` plus TypeScript and Gitleaks.
- `thorough`: every check, including project analysis and OSV vulnerability comparison.

Every check can be set to severity `off`, `warn`, or `error`. A warning remains visible but does not block. An enabled check that cannot complete returns exit code 2 when `failOnIncomplete` is enabled.

File overrides may change severity, timing, and supported numeric thresholds. Network policy is deliberately repository-wide: file-scoped vulnerability network overrides are rejected so an online execution can never escape disclosure or network throttling.
