# Checks

Zedbee owns the analyzer versions and inert configuration used by every v1 check. `relevant` checks run when staged state can affect them; `always` checks run whenever their required project inputs exist. Analysis scope may be broader than the changed lines, while attribution still blocks only new or worsened staged responsibility.

| Check ID                 | Coverage                                                    | Scope and attribution                                                                                                          | Important limitation                                                                                             |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `formatting`             | Prettier formatting                                         | Transforms staged target files and intersects formatting changes with added lines                                              | Reports only; v1 never applies fixes                                                                             |
| `lint`                   | ESLint, typescript-eslint, and managed correctness rules    | Compares workspace diagnostics and attributes locations/entities                                                               | Does not load project ESLint plugins or executable config                                                        |
| `types`                  | TypeScript diagnostics                                      | Compares isolated baseline/target programs for each workspace                                                                  | TypeScript source requires a contained staged `tsconfig.json`                                                    |
| `cyclomaticComplexity`   | Branch-path complexity                                      | Compares changed syntax entities against `max` and worsening policy                                                            | Thresholds require team calibration                                                                              |
| `readabilityComplexity`  | Zedbee's original nesting/readability metric                | Compares changed syntax entities against `max` and worsening policy                                                            | It is not Sonar Cognitive Complexity and scores are not interchangeable                                          |
| `structuralSecurity`     | Managed ast-grep rules for high-confidence local patterns   | Compares rule/location observations in JavaScript and TypeScript source                                                        | Narrower than Semgrep; no general taint, dataflow, reachability, interfile, or live registry coverage            |
| `secrets`                | Secretlint 13.0.4 recommended preset                        | Compares redacted baseline/target locations; an ephemeral keyed source-range digest detects same-location replacement          | Scans changed regular UTF-8 files up to 1 MiB, not Git history; pattern matches can need review                  |
| `duplication`            | jscpd clone detection and repository duplication percentage | Compares whole workspaces and attributes new clone regions/project regressions                                                 | Large source lists can exceed an operating-system argument limit                                                 |
| `dependencyArchitecture` | Dependency Cruiser cycles and invalid dependency edges      | Compares the workspace module graph                                                                                            | Uses managed rules, not a project's executable dependency-cruiser config                                         |
| `deadCode`               | Knip unused files, exports, and dependency hygiene          | Compares each workspace as a project                                                                                           | Framework plugins are disabled; dynamic conventions and aliases can require future managed profiles              |
| `reactCorrectness`       | React, Hooks, and JSX correctness                           | Runs only in discovered React/Ink/Next/Remix workspaces; calibrates each baseline/target workspace from staged dependency data | Uses the staged manifest, an unambiguous supported lockfile when available, then the managed React 19.2 fallback |
| `reactAccessibility`     | React DOM JSX accessibility                                 | Runs only for React DOM, Next.js, and Remix—not Ink terminal UI                                                                | Static JSX rules cannot prove runtime accessibility                                                              |
| `vulnerabilities`        | Zedbee's bounded OSV API v1 client                          | Compares advisory/package/dependency-path state when supported lockfiles change or timing is `always`                          | Online only; discloses package name, exact version, and npm ecosystem identifier to `api.osv.dev`                |

## Incomplete staged inputs

Intent-to-add records supply no staged file content, so Zedbee excludes them as unstaged. A Git LFS pointer that is actually staged remains in scope but cannot be analyzed as the referenced file; Zedbee reports the repository-relative path and returns incomplete. Materialize the LFS object, stage it again, and rerun the scan. Configurable ignore lists for intentionally unsupported staged paths are deferred beyond v1.

Complete JSON, text, and SARIF exports report every attributed finding. Automatic terminal output and explicit Ink show 25 findings by default, with blockers first, while keeping counts, disclosures, incomplete checks, warnings, guidance, and report paths complete. Automatic scans always write a complete versioned temporary JSON report, including a pass with zero findings; explicit Ink writes one only when its finding preview overflows. Explicit text, JSON, and SARIF write no sidecar. Use explicit JSON or SARIF output/redirection for a durable export.

## Profiles

- `fast`: local formatting, lint, complexity, structural security, and applicable React checks.
- `recommended`: `fast` plus TypeScript and Secretlint.
- `thorough`: every check, including project analysis and OSV vulnerability comparison.

Every check can be set to severity `off`, `warn`, or `error`. A warning remains visible but does not block. An enabled check that cannot complete returns exit code 2 when `failOnIncomplete` is enabled.

## Managed customization

Exactly seven configurable checks expose settings beyond severity and timing:

| Check ID                | Managed settings                                                                       | Defaults and boundary                                                          |
| ----------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `formatting`            | Fourteen Prettier options under `settings`                                             | File-scoped; defaults are listed below                                         |
| `lint`                  | Bundled ESLint and typescript-eslint `rules`                                           | File-scoped and limited to rule IDs Zedbee ships                               |
| `cyclomaticComplexity`  | Positive safe-integer `max`; Boolean `blockWorsening`                                  | `max: 20`, `blockWorsening: true`; file-scoped                                 |
| `readabilityComplexity` | Positive safe-integer `max`; Boolean `blockWorsening`                                  | `max: 15`, `blockWorsening: true`; file-scoped                                 |
| `duplication`           | Percentage `threshold`; `settings.minLines`, `settings.minTokens`, and `settings.mode` | `threshold: 5`, `minLines: 5`, `minTokens: 50`, `mode: "mild"`; workspace-wide |
| `reactCorrectness`      | Bundled React and Hooks `rules`                                                        | File-scoped and limited to rule IDs Zedbee ships                               |
| `reactAccessibility`    | Bundled jsx-a11y `rules`                                                               | File-scoped and limited to rule IDs Zedbee ships                               |

A target-only score above `max` and a staged score that crosses `max` are blocking. `blockWorsening: true` additionally blocks an increase when both the baseline and target were already above `max`; set it to `false` to tolerate that above-limit worsening while teams pay down existing debt. Duplication `threshold` accepts 0 through 100. `minLines` and `minTokens` are positive integers. Duplication mode is one of `strict`, `mild`, or `weak`.

### Prettier settings

The formatting check accepts all and only these fourteen Prettier fields. Values not listed here, including `parser` and plugin settings, are rejected.

| Field                        |       Default | Accepted value                                 |
| ---------------------------- | ------------: | ---------------------------------------------- |
| `printWidth`                 |          `80` | Positive integer                               |
| `tabWidth`                   |           `2` | Positive integer                               |
| `useTabs`                    |       `false` | Boolean                                        |
| `semi`                       |        `true` | Boolean                                        |
| `singleQuote`                |       `false` | Boolean                                        |
| `quoteProps`                 | `"as-needed"` | `"as-needed"`, `"consistent"`, or `"preserve"` |
| `jsxSingleQuote`             |       `false` | Boolean                                        |
| `trailingComma`              |       `"all"` | `"all"`, `"es5"`, or `"none"`                  |
| `bracketSpacing`             |        `true` | Boolean                                        |
| `bracketSameLine`            |       `false` | Boolean                                        |
| `arrowParens`                |    `"always"` | `"always"` or `"avoid"`                        |
| `proseWrap`                  |  `"preserve"` | `"always"`, `"never"`, or `"preserve"`         |
| `endOfLine`                  |        `"lf"` | `"lf"`, `"crlf"`, `"cr"`, or `"auto"`          |
| `embeddedLanguageFormatting` |      `"auto"` | `"auto"` or `"off"`                            |

### Bundled ESLint and React rules

`lint`, `reactCorrectness`, and `reactAccessibility` accept a `rules` object. A value can be a severity (`"off"`, `"warn"`, `"error"`, `0`, `1`, or `2`) or an array such as `["error", { "argsIgnorePattern": "^_" }]`. Each check has a bounded editor-schema inventory: bundled rules are supported, while unknown rules, rules belonging to another check, and custom plugins are rejected. Rule options are validated against Zedbee's pinned ESLint and plugin versions, so compatibility follows the versions printed by `zedbee checks` and may change only with a Zedbee engine upgrade.

```jsonc
{
  "schemaVersion": 1,
  "checks": {
    "lint": {
      "rules": {
        "no-console": "warn",
        "@typescript-eslint/no-unused-vars": [
          "error",
          { "argsIgnorePattern": "^_" },
        ],
      },
    },
    "reactCorrectness": {
      "rules": {
        "react/prop-types": "off",
        "react-hooks/rules-of-hooks": "error",
      },
    },
    "reactAccessibility": {
      "rules": { "jsx-a11y/no-autofocus": "warn" },
    },
  },
}
```

### Ordered file overrides

File overrides are evaluated in array order independently for every repository-relative file. All matching entries contribute a patch; a later matching override takes precedence only for fields it supplies. Settings omitted by that later entry retain the result of the profile, repository check policy, and earlier matches.

```jsonc
{
  "schemaVersion": 1,
  "checks": {
    "formatting": { "settings": { "printWidth": 100 } },
    "cyclomaticComplexity": { "max": 20, "blockWorsening": true },
    "duplication": {
      "threshold": 5,
      "settings": { "minLines": 5, "minTokens": 50, "mode": "mild" },
    },
  },
  "overrides": [
    {
      "files": ["packages/**"],
      "checks": {
        "formatting": { "settings": { "printWidth": 90 } },
        "cyclomaticComplexity": { "max": 18 },
      },
    },
    {
      "files": ["packages/legacy/**"],
      "checks": {
        "formatting": { "settings": { "printWidth": 120 } },
        "cyclomaticComplexity": { "blockWorsening": false },
      },
    },
  ],
}
```

For `packages/legacy/view.ts`, the example resolves formatting `printWidth` to 120, complexity `max` to 18, and `blockWorsening` to false. A file outside `packages/**` keeps the repository values. This is true per-file last-match behavior, not one merged workspace policy.

Duplication analysis is workspace-wide because jscpd compares clone regions and the duplication percentage across a whole workspace. Configure `threshold`, `minLines`, `minTokens`, and `mode` only under the root `checks.duplication`; putting them in `overrides` is rejected. Overrides may still supply duplication severity or timing, but Zedbee resolves those patches conservatively for the whole workspace target rather than per clone finding. OSV availability policy is also repository-wide: `checks.vulnerabilities.onUnavailable` accepts `block` or `warn`, while file-scoped availability overrides are rejected.

Run `zedbee checks` to inspect effective settings and configured overrides. Its output identifies whether each root value came from the selected profile or repository configuration; `zedbee checks --format json` returns the complete deterministic metadata.

## Managed-only configuration boundary

Zedbee does not load a project's native analyzer config. It ignores native Prettier, ESLint, plugin, parser, and executable analyzer configuration in favor of its pinned engines and inert managed settings. Teams with native configs may see different Zedbee results because those files are not loaded. Adopt Zedbee by calibrating the supported `.zedbeerc.jsonc` settings and rule inventory, not by assuming identical results from an existing native tool invocation.
