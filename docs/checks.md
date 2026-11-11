# Checks

Scan and fix analysis opens fresh sessions in reusable supervised workers,
normally shared through a private local service. Session release clears source
and project state. Compiler-backed React checks retire their worker on release;
Knip uses a fresh internal worker for each snapshot side, and jscpd launches its
managed child tool. The CLI owns applicability, attribution, policy, and reports. See the
[execution boundary](support.md#managed-configuration-compatibility) for isolation
limits and cache exclusions, and [diagnostics](reporting.md#safe-analyzer-diagnostics)
for investigating incomplete analyzer jobs.

Zedbee owns the analyzer versions and inert configuration used by every v1 check. `relevant` checks run when staged state can affect them; `always` checks run whenever their required project inputs exist. Analysis scope may be broader than the changed lines, while attribution still blocks only new or worsened staged responsibility.

Check selection uses the selected baseline and target snapshots before starting
analyzer workers. An eligible scan with no analyzer jobs still validates its
configuration and selected inputs, reports the real changed-file count and
skipped checks, and avoids opening an analyzer session or capturing source for
analysis. Skipped checks have not analyzed and passed their inputs.

With the recommended profile, ordinary files, default managed formatting and
`when: "relevant"`, the following changes select these checks:

| Selected changes                                                | Analyzer jobs          |
| --------------------------------------------------------------- | ---------------------- |
| Python edits                                                    | Secrets                |
| `.gitignore` edit plus removal of a Markdown file from tracking | Secrets                |
| Markdown deletion only                                          | None                   |
| Markdown edit                                                   | Formatting and secrets |

Secrets is language-independent: a new secret in Python, Markdown or
`.gitignore` remains eligible. Deleted files have no target text to scan. A
secrets-only scan captures changed target files and their baseline counterparts,
including previous rename paths, rather than unrelated workspace source.
Profiles, overrides, exclusions and explicit `always` timing can change the
selected checks. Project Prettier support is determined within the explicitly
trusted formatter boundary, including its plugins, so an unfamiliar extension
does not by itself rule out formatting. Ignore-file edits do not expand
formatting to every unchanged file.

| Check ID                 | Coverage                                                    | Scope and attribution                                                                                                          | Important limitation                                                                                             |
| ------------------------ | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| `formatting`             | Prettier formatting                                         | Transforms staged target files and intersects formatting changes with added lines                                              | Managed fixing formats the complete current working file, including unstaged work                                |
| `lint`                   | ESLint, typescript-eslint, and managed correctness rules    | Compares workspace diagnostics and attributes locations/entities                                                               | Does not load project ESLint plugins or executable config                                                        |
| `types`                  | TypeScript diagnostics                                      | Compares isolated baseline/target programs for each workspace                                                                  | Changed source and source losing coverage require a contained snapshot project                                   |
| `cyclomaticComplexity`   | Branch-path complexity                                      | Compares changed syntax entities against `max` and worsening policy                                                            | Thresholds require team calibration                                                                              |
| `readabilityComplexity`  | Zedbee's original nesting/readability metric                | Compares changed syntax entities against `max` and worsening policy                                                            | It is not Sonar Cognitive Complexity and scores are not interchangeable                                          |
| `structuralSecurity`     | Managed ast-grep rules for high-confidence local patterns   | Compares rule/location observations in JavaScript and TypeScript source                                                        | Narrower than Semgrep; no general taint, dataflow, reachability, interfile, or live registry coverage            |
| `secrets`                | Secretlint 13.0.5 recommended preset                        | Compares redacted baseline/target locations; an ephemeral keyed source-range digest detects same-location replacement          | Scans changed regular UTF-8 files up to 1 MiB, not Git history; pattern matches can need review                  |
| `duplication`            | jscpd clone detection and repository duplication percentage | Compares whole workspaces and attributes new clone regions/project regressions                                                 | Large source lists can exceed an operating-system argument limit                                                 |
| `dependencyArchitecture` | Dependency Cruiser cycles and invalid dependency edges      | Compares the workspace module graph                                                                                            | Uses managed rules, not a project's executable dependency-cruiser config                                         |
| `deadCode`               | Knip unused files, exports, and dependency hygiene          | Compares each workspace as a project; saved findings require validated snapshot inputs and package-absence guards              | Framework plugins are disabled; dynamic framework conventions can require future managed profiles                |
| `reactCorrectness`       | React, Hooks, and JSX correctness                           | Runs only in discovered React/Ink/Next/Remix workspaces; calibrates each baseline/target workspace from staged dependency data | Uses the staged manifest, an unambiguous supported lockfile when available, then the managed React 19.2 fallback |
| `reactAccessibility`     | Static JSX accessibility checks                             | Runs only for React DOM, Next.js, and Remix—not Ink terminal UI                                                                | Static JSX rules cannot prove runtime accessibility                                                              |
| `vulnerabilities`        | Zedbee's bounded OSV API v1 client                          | Compares advisory/package/dependency-path state when supported lockfiles change or timing is `always`                          | Online only; discloses package name, exact version, and npm ecosystem identifier to `api.osv.dev`                |

## Incomplete staged inputs

The secrets check skips files classified as binary in each selected Git snapshot, including images larger than 1 MiB. Its 1 MiB safety limit applies to text files, regardless of their extension. Binary-to-text changes still scan the new text for secrets.

Intent-to-add records supply no staged file content, so Zedbee excludes them as unstaged. A Git LFS pointer that is actually staged remains in scope but cannot be analyzed as the referenced file; Zedbee reports the repository-relative path and returns incomplete. With LFS tracking active, materializing and staging the object again recreates the pointer. Validate the referenced object separately; that validation does not clear Zedbee's incomplete result. If the file is appropriate for ordinary tracked text, deliberately convert it out of LFS tracking, then review, stage, and rescan. In committed base mode, that conversion must be committed. An intentional repository policy can instead exclude the path from the affected checks with `pathExclusions`; an exclusion suppresses those checks and does not validate the object.

Complete JSON, text, and SARIF exports report every attributed finding. Automatic terminal output and explicit Ink show 25 findings by default, with blockers first, while keeping counts, disclosures, incomplete checks, warnings, guidance, and report paths complete. Automatic scans always write a complete versioned temporary JSON report, including a pass with zero findings; explicit Ink writes one only when its finding preview overflows. Explicit text, JSON, and SARIF write no sidecar. Use explicit JSON or SARIF output/redirection for a durable export.

## TypeScript diagnostics

`types` and typed `lint` inspect changed paths against source and configuration
metadata from both selected snapshots. Ordinary Python, documentation and
`.gitignore` changes do not select compiler jobs when that metadata establishes
that they are unrelated. JavaScript/TypeScript source, deletions and renames,
JSON/JSONC data, manifests, lockfiles and compiler configuration remain relevant.
A contained inherited configuration is relevant even with an unusual filename
such as `compiler.md`. Known source/configuration membership takes precedence
over the filename extension. Unknown inputs and incomplete configuration
metadata conservatively retain analysis; policy configuration edits may also
select compiler jobs even when only reporting settings changed.

When a possible compiler input changes, both checks still conservatively check
every discovered workspace containing TypeScript sources, including unchanged
consumers and sibling workspaces. Both compare findings across the project,
including unchanged files. Existing
baseline findings remain non-blocking when unchanged source moves or is renamed.
File policies still control which lint findings are enabled. `when: "always"`
retains full project comparison for a nonempty changeset even when its changed
paths would otherwise be unrelated. Other analyzers retain their own input
scope rules.

Types and typed lint share project discovery and validated compiler inputs within
an analysis session, with separate mutable TypeScript programs for each check.
They load contained snapshot projects, including sibling
configurations and project references. An option-only configuration used through
`extends` is a helper. Canonical `tsconfig.json`, configurations declaring their
own source selectors or project references, and explicitly referenced
configurations retain their project role. In the default `when: "relevant"` mode,
project coverage is required for changed TypeScript files and files that lose
their baseline coverage. Unchanged files already outside every loaded project
are skipped, so an existing coverage gap in an untouched project does not block
an unrelated commit. `when: "always"` requires coverage for every enabled file.
Configuration failures report the
safe repository-relative configuration path, TypeScript diagnostic code when
available, and affected snapshot; raw compiler messages are not exported.

The `types` check compares diagnostics across the analyzed project. A changed
declaration can introduce errors at unchanged references in the same file or in
other project files; those new diagnostics are reported even when their lines
were not edited. This includes changed function signatures, changed exported
types, removed exports, and deleted TypeScript files. A source deletion still
triggers analysis of the affected project’s remaining TypeScript files.
Existing diagnostics remain non-blocking when their unchanged
source lines move. A changed diagnostic message is compared separately from an
existing diagnostic at the same location. This applies to both staged and
`--base` scans.

## Snapshot import resolution

`deadCode` and `dependencyArchitecture` honor TypeScript `paths` mappings from
contained snapshot configurations, including inherited mappings and mappings
without an explicit `baseUrl`. Resolution uses each workspace's own captured
configuration and files; native analyzer configuration and framework plugins
remain disabled. Dependency architecture also resolves explicit stylesheet
imports through those mappings.

Changes to a workspace's TypeScript configuration or a contained inherited
configuration can introduce new graph findings in otherwise unchanged source.
Those checks compare baseline and target configuration independently. An
unrelated workspace's existing invalid configuration does not become required
merely because another workspace changed.

Both complexity checks distinguish members of separate inline TypeScript classes,
including anonymous classes with constructor parameter properties. Existing
complexity debt remains non-blocking when a harmless edit leaves its score
unchanged.
When several anonymous classes are rewritten and reordered together without an
unambiguous source match, unmatched members are treated as new rather than
inheriting another class's baseline metrics.

## Profiles

- `fast`: local formatting, lint, complexity, structural security, and applicable React checks.
- `recommended`: `fast` plus TypeScript and Secretlint.
- `thorough`: every check, including project analysis and OSV vulnerability comparison.

Every check can be set to severity `off`, `warn`, or `error`. A warning remains visible but does not block. An enabled check that cannot complete returns exit code 2 when `failOnIncomplete` is enabled.

## Managed fix availability

`zedbee fix` rescans the current index and includes warning and blocking
candidates for `formatting`, `lint`, and `reactCorrectness`. The managed fix
boundary for lint and React is exact reported official fixes only. Analyzer
suggestions remain manual, as do every finding from unsupported checks such as
types, accessibility, complexity, security, secrets, duplication, architecture,
dead code, and vulnerabilities.

Exact lint and React fixes are composed with non-overlapping working changes.
When formatting is selected, Prettier then formats the complete current working
file, including unstaged work. Zedbee never mutates the index. Use
[`zedbee fix`](managed-fixes.md) for preview, selection, conflicts, partial
progress, JSON, and the review-stage-rescan workflow.

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
| `reactAccessibility`    | Bundled jsx-a11y `rules` and custom component/attribute/polymorphic `settings`         | File-scoped and limited to rule IDs Zedbee ships                               |

A target-only score above `max` and a staged score that crosses `max` are blocking. `blockWorsening: true` additionally blocks an increase when both the baseline and target were already above `max`; set it to `false` to tolerate that above-limit worsening while teams pay down existing debt. Duplication `threshold` accepts 0 through 100. `minLines` and `minTokens` are positive safe integers. Duplication mode is one of `strict`, `mild`, or `weak`.

`reactAccessibility.settings` accepts only `components` (component-to-element map),
`attributes` (DOM attribute-to-JSX-properties arrays), `polymorphicPropName`, and
`polymorphicAllowList`. Settings are file-scoped and default to no custom mappings.
See [static JSX accessibility examples and limitations](react-analysis.md#static-jsx-accessibility-checks).
These checks cannot certify runtime accessibility.

### Prettier settings

Formatting scans and fixes leave generated package-manager lockfiles alone:
`package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`,
`bun.lock`, and `bun.lockb`, including copies in subdirectories. Other JSON
and YAML files are still checked. This does not exclude lockfiles from secrets
or supported vulnerability checks.

Formatting comparisons have a two-second limit per file. If a comparison takes longer, Zedbee reports `FORMATTING_DIFF_TIMEOUT` and marks the check incomplete. It does not guess which staged lines changed or treat the file as passing. Format the affected file with Prettier directly or manually, using the intended formatting settings, then review, stage, and scan again. A persistently incomplete formatting check cannot produce a managed `zedbee fix formatting` action.

The formatting check accepts all and only these fourteen Prettier fields. Values not listed here, including `parser` and plugin settings, are rejected.

### Formatting engines

`checks.formatting.engine` selects the formatting engine and defaults to `"managed"` when omitted. Existing configurations keep managed behavior.

- `"managed"` uses Zedbee's bundled Prettier with the fourteen managed settings below. Its separate installation preserves the project's own Prettier version and command.
- `"project"` uses the selected project's installed Prettier (supported range `>=3.0.0 <4.0.0`), its native configuration, and its plugins. `settings` cannot be combined with `engine: "project"`.

During `zedbee init`, when an existing setup is found you can copy supported settings once into `.zedbeerc.jsonc` (`--formatting copy`), use the project's Prettier (`--formatting project`), keep Zedbee defaults (`--formatting managed`), or stop checking formatting (`--formatting off`). A copy is a one-time import; Zedbee does not synchronize it afterwards, and plugins and unsupported options are not copied. With separate consent, copy mode evaluates every selected executable or package-exported shared configuration through its owning project's supervised Prettier worker, retains only representable settings, and binds the preview to every evaluated configuration file so a change in any scope invalidates the apply. Project-root `.prettierignore` and `.gitignore` rules are copied as formatting-only path exclusions, preserving their order, negations, and directory-relative meaning. Subsequent scans use the saved rules; editing the original ignore file does not refresh the copy.

Representable native override `excludeFiles` patterns are copied with the override, preserving native basename/path matching groups and negated include patterns. These files keep their normal formatting settings; they are not skipped. Pattern combinations that cannot be copied exactly, including negated `excludeFiles`, are shown as limitations; noninteractive copy makes no writes while limitations remain. EditorConfig-only setups and nested EditorConfig scopes are included; nonfinite values such as `max_line_length=off` are disclosed rather than silently converted.

Project-format reports include `formattingCoverage` counts for `checkedFiles`, `ignoredFiles`, and `unsupportedFiles`. Ignored and unsupported files are not counted as checked. An entirely ignored/unsupported run is skipped.

During setup, Prettier discovery includes tracked files and nonignored untracked files in the current repository. Ignored checkout folders and nested Git repositories or worktrees are excluded, so they do not create formatting overrides. Tracked files remain part of the project even if an ignore rule also matches them.

Project execution is an explicit trust decision. Choosing it in `init` records consent in local Git configuration keyed to the shared Git repository directory and project root. Consent carries across branches and linked worktrees, and repeated setup honors saved consent. Existing checkout-scoped grants from registered worktrees are also honored; a fresh clone needs its own consent, and CI must pass `--trust-project-prettier` from a trusted workflow. That flag is invocation-only outside `init`. Switching to managed formatting or turning formatting off in `init` revokes the corresponding project grants across the repository’s worktrees. `--yes` alone never grants it, and tracked repository configuration can never grant it. When the installation is missing, the version is unsupported, a plugin is missing, the configuration is invalid, or trust is absent, the formatting check is incomplete with a concrete remedy. Zedbee never silently falls back to managed formatting, and project-format results are not persisted in the observation cache. Managed behavior is unchanged when `engine` is omitted.

Do not grant project-Prettier trust automatically to unreviewed pull-request code. Native configuration and plugins are project code with the invoking user's permissions; the worker boundary supervises their lifetime but is not an operating-system sandbox. The selected Git snapshot supplies configuration files, relative helpers, ignore files, and source bytes, so an unstaged helper edit cannot alter an index scan.

`zedbee checks` shows the effective engine and, for project mode, every detected project root and version that can participate in the configured formatting policy. Mixed managed/project repositories receive a summary plus `effectiveEngines` entries in JSON; text and Ink output list the same scopes individually. `zedbee doctor` inspects project setup as data only; pass `--trust-project-prettier` to run the same installation and snapshot probe used by scans.

| Field                    |       Default | Accepted value                                 |
| ------------------------ | ------------: | ---------------------------------------------- |
| `printWidth`             |          `80` | Positive safe integer                          |
| `tabWidth`               |           `2` | Positive safe integer                          |
| `useTabs`                |       `false` | Boolean                                        |
| `semi`                   |        `true` | Boolean                                        |
| `singleQuote`            |       `false` | Boolean                                        |
| `quoteProps`             | `"as-needed"` | `"as-needed"`, `"consistent"`, or `"preserve"` |
| `jsxSingleQuote`         |       `false` | Boolean                                        |
| `trailingComma`          |       `"all"` | `"all"`, `"es5"`, or `"none"`                  |
| `bracketSpacing`         |        `true` | Boolean                                        |
| `bracketSameLine`        |       `false` | Boolean                                        |
| `arrowParens`            |    `"always"` | `"always"` or `"avoid"`                        |
| `proseWrap`              |  `"preserve"` | `"always"`, `"never"`, or `"preserve"`         |
| `endOfLine`              |        `"lf"` | `"lf"`, `"crlf"`, `"cr"`, or `"auto"`          |
| `singleAttributePerLine` |       `false` | Boolean                                        |

### Duplication settings

Duplication uses these workspace-wide values:

| Field       |  Default | Accepted value                    |
| ----------- | -------: | --------------------------------- |
| `threshold` |      `5` | Finite percentage from 0 to 100   |
| `minLines`  |      `5` | Positive safe integer             |
| `minTokens` |     `50` | Positive safe integer             |
| `mode`      | `"mild"` | `"strict"`, `"mild"`, or `"weak"` |

The bundled jscpd 5.3.2 counts both endpoints of a cloned line range. Compared with jscpd 5.2.1, duplicated-line totals can increase by one line per clone, which can raise the reported percentage near a configured threshold.

Duplication attribution compares individual source occurrences across the selected snapshots. In the default mild mode, comment and whitespace edits to an existing clone do not introduce duplication. This also applies when those edits alone move the physical-line percentage over the threshold: the source inventory and significant tokens must remain unchanged. New copies and enlarged clone regions remain eligible findings. Multiple analyzer pairs referencing the same physical occurrence produce one diagnostic for that occurrence.

### Bundled ESLint and React rules

`lint`, `reactCorrectness`, and `reactAccessibility` accept a `rules` object. A value can be a severity (`"off"`, `"warn"`, `"error"`, `0`, `1`, or `2`) or an array such as `["error", { "argsIgnorePattern": "^_" }]`. Each check has a bounded editor-schema inventory: bundled rules are supported, while unknown rules, rules belonging to another check, and custom plugins are rejected. Rule options follow the analyzer and plugin versions pinned by the installed Zedbee release and may change only with a Zedbee engine upgrade.

`lint.typeInformation` accepts `"required"` or `"when-available"` and defaults to `"required"`. Typed lint loads every contained TypeScript project in a workspace. A file covered by any loaded project receives type-aware rules. Under `"required"`, an uncovered file blocks typed lint if it changed, lost its baseline coverage, or has `when: "always"`; unchanged existing coverage gaps are skipped. Under an explicit `"when-available"` file policy, it receives the bundled basic TypeScript rules without rules that require project type information. This setting is file-scoped and can be limited with an override such as `{ "files": ["tools/*.ts"], "checks": { "lint": { "typeInformation": "when-available" } } }`.

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

There are two ways to exclude files:

- Use `excludeFiles` inside an override to leave matching files on their normal settings. This works for every check supported in file overrides.
- Use `pathExclusions` to skip named checks entirely for matching files. Other checks still run.

```json
{
  "schemaVersion": 1,
  "overrides": [
    {
      "files": ["src/**"],
      "excludeFiles": ["src/generated/**"],
      "checks": { "formatting": { "settings": { "tabWidth": 4 } } }
    }
  ],
  "pathExclusions": [
    {
      "files": ["vendor/**"],
      "checks": ["formatting"],
      "reason": "Preserve vendor formatting"
    }
  ]
}
```

Here, `src/generated/**` still gets checked with the normal formatting settings. `vendor/**` skips formatting. Excluding a file from one override does not stop a later override from matching it.

File overrides are evaluated in array order independently for every repository-relative file. All matching entries contribute a patch; a later matching override takes precedence only for fields it supplies. Settings omitted by that later entry retain the result of the profile, repository check policy, and earlier matches.

```jsonc
{
  "schemaVersion": 1,
  "checks": {
    "formatting": {
      "settings": { "printWidth": 100, "singleAttributePerLine": true },
    },
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

Run `zedbee checks` to inspect effective settings and configured overrides. Its output identifies whether each root value came from the selected profile or repository configuration and includes the primary managed engine summary; it is not an inventory of every supporting package version. `zedbee checks --format json` returns the complete deterministic settings metadata.

## Configuration boundary

By default Zedbee runs a managed boundary: it does not load a project's native analyzer config. It ignores native ESLint, plugin, parser, and executable analyzer configuration in favor of its pinned engines and inert managed settings, and native Prettier configuration is ignored unless the project formatting engine is explicitly trusted. Teams with native configs may see different Zedbee results because those files are not loaded. Adopt Zedbee by calibrating the supported `.zedbeerc.jsonc` settings and rule inventory, not by assuming identical results from an existing native tool invocation.

The single exception is formatting: with `checks.formatting.engine` set to `"project"` plus an explicit trust decision, Zedbee runs the project's installed Prettier, its native configuration, and its plugins in a supervised worker. This exception never applies to ESLint, Secretlint, or any other managed analyzer. See [formatting engines](#formatting-engines).

The generated `.husky/install.mjs` installer may import declared development dependencies. This exception does not exempt missing declarations, classify hook files as tests, or apply to other hook scripts.

Next.js dead-code analysis recognizes default framework entries from each captured
workspace declaring `next`. App Router conventions include page, layout, route,
template, default, error, loading, not-found, forbidden and unauthorized files;
global-error and global-not-found apply at the app root. Pages Router routes,
API routes and special pages are entries. Root app/pages directories shadow their
src counterparts independently, including empty root directories. Private app
subtrees beginning with `_` are excluded; route groups, slots and dynamic segments
remain supported. Default extensions are js/jsx/ts/tsx, excluding declarations.
Metadata includes root or one-group manifest/robots (js/ts), nested sitemap
(js/ts), and nested icon/apple-icon/opengraph-image/twitter-image (js/jsx/ts/tsx).
Root or src instrumentation, instrumentation-client, middleware and proxy files
are also entries. Root next.config.js/mjs/cjs/ts/mts and next-env.d.ts are analyzed
as inert source. Configuration is never evaluated and analyzer plugins remain
disabled. Only `next` is exempted from unused dependency reporting when a concrete
supported route, runtime support file or config exists; next-env alone is insufficient.
Framework entries use Knip's entry-export exemption, so their exports are not
checked for exact framework consumption. Reachable library exports still receive
normal analysis. Custom `pageExtensions`, MDX/custom compilers and
`next <command> <subdirectory>` discovery are outside these default conventions.

### Synthetic credentials in fixtures

Secretlint can recognize a deliberately fake database URL as a credential. For a confirmed synthetic fixture, suppress just the database rule on the next line, with a reason:

```python
# secretlint-disable-next-line @secretlint/secretlint-rule-database-connection-string -- Synthetic redaction fixture
DATABASE_URL = "postgresql://fixture:fake_password@db.example.invalid/test"
```

```javascript
// secretlint-disable-next-line @secretlint/secretlint-rule-database-connection-string -- Synthetic redaction fixture
const databaseUrl =
  "postgresql://fixture:fake_password@db.example.invalid/test";
```

Stage the annotation together with the fixture. It suppresses the named rule on that one line; other rules and adjacent lines remain protected. This is an intentional suppression, not verification that a credential is fake. Remove and rotate real credentials. Test directories and localhost URLs are not automatically exempt.

For dedicated fixture files, an exact-file `pathExclusions` entry with `checks: ["secrets"]` and a reason is also supported. That excludes the whole file from that check and is broader than the next-line annotation.

### Experimental project ESLint

Swarm's default lint mode uses its bundled rules. To use your project's own
ESLint, run `zedbee init --eslint-engine project` and review the proposal.
Project configuration and plugins execute JavaScript with your user privileges;
setup asks for separate ESLint execution trust. Prettier trust does not grant it.
For an explicit noninteractive setup, use
`zedbee init --eslint-engine project --trust-project-eslint --yes`.

You can also select `checks.lint.engine: "project"` in `.zedbeerc.jsonc`.
A workspace override must select its entire subtree, for example
`"files": ["packages/web/**"]`; individual-file engine selection is rejected.
Use `zedbee doctor` to inspect configuration, installation, and saved trust
without executing your project configuration.

Within a selected workspace, project ESLint supplies lint, React, and JSX
accessibility rules. Swarm shows its separate managed React checks as covered
by project ESLint; that does not establish that your configuration enables
accessibility rules. Formatting, complexity, secrets, and other independent
checks remain separate. Explicit managed rule/settings or React severity
settings must be resolved before selecting project mode; setup preserves and
explains conflicts instead of silently discarding them.

The initial supported environment is installed **ESLint 9.39.5**, JavaScript flat
configuration (`eslint.config.js`, `.mjs`, or `.cjs`), ordinary local node_modules,
and an npm package-lock v2 or v3 matching the selected target's direct installed
dependencies. Swarm does not automatically install dependencies. Legacy
`.eslintrc`, processors, TypeScript configuration modules, Yarn PnP, and extra
file formats are outside this initial boundary. Captured files over 32 MiB or a mirror that cannot reproduce every captured input make project analysis incomplete rather than silently omitting data. Next.js, Jest, and import-plugin
combinations have not yet been certified by the compatibility fixtures. Plugin
results use ESLint's standard interface; unsupported execution or a plugin crash
is incomplete analysis, with no silent managed fallback. Project-rule automatic
fixes are not enabled.

Project mode analyzes captured source and local configuration imports. Both
baseline and target configurations run in fresh processes using the target's
validated installed toolchain; Swarm does not recreate historical installations.
A newly introduced configuration can establish new coverage without a baseline
config. A broken existing baseline remains incomplete. Configurations requiring
external local files, live checkout paths, network state, or extra environment
variables are not guaranteed to reproduce. The worker receives PATH, fixed locale,
a temporary HOME/TMPDIR, and Windows system paths where needed.

A project plugin can inspect files beyond the source file it reports on, so
project mode runs its configured JS/TS scope for every nonempty repository
change, including Markdown and deletion-only changes. It does not use persistent
result caching. This can take longer than managed mode. An all-ignored scope is
reported as skipped, rather than a successful lint run. JSON check results expose
`eslintAnalysis` with the installed version, checked/ignored/excluded counts, baseline
comparison state, and effective message policy.

Project findings preserve rule IDs, severity, and locations. Messages are
redacted by default because plugins can quote source. Setting
`reporting.projectEslintMessages: "full"` also requires separate local permission;
setup offers this separately, or use `--allow-project-eslint-messages` with the
explicit project setup command. Without permission, analysis continues with
redacted messages. Full local messages can contain source in terminal and saved
JSON reports. Source-bearing messages and private rule identifiers are not sent
to telemetry. Returning to managed mode does not remove reports already written.

### Rule severity and focusable separators

For bundled lint, React, and accessibility rules, an explicit per-rule `warn`
remains a warning under an `error` check. Check-level `warn` limits enabled rules
to warnings; check or rule `off` disables its applicable scope. Numeric and array
rule forms follow the same precedence. An error from another enabled rule still
blocks the commit.

Swarm corrects jsx-a11y 6.10.2's treatment of a literal focusable
`role="separator"` with `aria-valuenow`: that pattern is an ARIA window splitter,
including programmatic focus through `tabIndex={-1}`. Plain unfocusable separators
with keyboard handlers and statically missing current values still report.
Ambiguous spread attributes do not receive the exception. This correction applies
to Swarm's managed engine; project ESLint retains the project's own plugin version
and behavior. It is a static check, not proof of runtime accessibility.

An existing JSX interaction finding can span an entire opening element, including
inline handlers. Swarm pairs an existing occurrence through its unchanged opening
line even when harmless handler edits expand the diagnostic range. A replacement
opening line or newly added occurrence is not exempt merely because it reuses a
line number.

The bundled Hooks plugin has known `set-state-in-effect` inconsistencies around
async helpers and wrappers. An `async` wrapper is not evidence that all updates
are asynchronous: called helpers execute synchronously until their first await.
Swarm does not disable this rule or silently rewrite project rules to hide the
limitation. Regression cases are retained while a complete upstream correction
is evaluated.
