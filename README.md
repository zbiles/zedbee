# Zedbee

Zedbee is a diff-aware pre-commit and CI scanner for JavaScript and TypeScript projects. Ordinary scans use the exact Git index; `scan --base <ref>` compares committed `HEAD` with its unique merge base. Findings are attributed to the selected target changes so unrelated existing debt stays out of the current developer's way.

The managed suite covers formatting, lint, TypeScript correctness, cyclomatic complexity, original readability complexity, structural security, duplication, dependency architecture, dead code/package hygiene, React correctness, and React DOM accessibility. Analyzers use the exact selected target snapshot, compare an isolated baseline where the check requires one, and pass observations through central changed-target attribution.

Scan and fix commands share a private local analyzer service with bounded, supervised workers. Each scan opens a fresh source session and releases source and project state before removing its snapshots. Reuse-capable engine modules can stay loaded; compiler-backed React checks retire their worker at session release. This is not an OS sandbox. See the [execution and configuration boundary](docs/support.md#managed-configuration-compatibility) and [safe diagnostic options](docs/reporting.md#safe-analyzer-diagnostics).

## Requirements

- Node.js versions matching `^22.17.0 || >=24.2.0`
- Git

## Install

Install the public beta from npm's `next` tag:

```bash
npm install --save-dev zedbee@next
```

Run a scan directly:

```bash
npx zedbee scan
```

Interactive commands can show an `UPDATE AVAILABLE` notice after their result.
Zedbee checks npm's public `latest` release in a background process and caches
the result for a day; a newly discovered update appears on a subsequent run.
Only newer stable releases compatible with your Node.js version are suggested.
The notice provides a manual update command for the detected project package
manager. It never installs anything, changes scan results, or waits for npm.
Unpublished packages, offline checks, and cache failures are silent.

Set `ZEDBEE_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1` to disable both checking
and notices. CI, redirected output, JSON, and SARIF also disable both. See the
[privacy guide](docs/privacy.md#update-notifications) for the network and cache details.

Scans never modify source files. `zedbee fix` is a separate, approval-gated
workflow that rescans current staged code, previews supported managed fixes, and
writes only working files. Zedbee never stages or commits. See the
[managed-fixes guide](docs/managed-fixes.md).

For guided setup, preview the detected project, recommended policy, network use, and exact hook/config edits:

```bash
npx zedbee init
```

Nothing is written until the interactive confirmation. Automation can apply the same proposal with `--yes`; use `--format json` for a deterministic machine-readable preview/result.

## Commands

| Command                 | Purpose                                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `zedbee init`           | Recommend checks and safely add `.zedbeerc.jsonc` plus a Husky, Lefthook, simple-git-hooks, or raw Git pre-commit integration                                |
| `zedbee scan`           | Scan the exact index target, or a committed target with `--base`, and return pass, blocked, or incomplete                                                    |
| `zedbee fix`            | Rescan current staged code, preview managed formatting/lint/React fixes, and apply approved changes to working files only                                    |
| `zedbee checks`         | Explain every configured check, applicability, targets, engine/license, network use, and limitation without running analysis                                 |
| `zedbee doctor`         | Diagnose Git, Node, configuration, snapshots, workspaces, hooks, Secretlint, lockfile parsing, licenses, and bounded OSV connectivity without running a scan |
| `zedbee service status` | Inspect the current installation/runtime's local service without starting one                                                                                |
| `zedbee service stop`   | Drain active sessions and wait for service and worker cleanup                                                                                                |

`scan --no-service` and `fix --no-service` use a local executor that closes with the command. Ordinary commands acquire the service only when analysis is needed; empty-index scans and help do not start it. The service stops after five minutes with no active sessions. `service status` and `service stop` support `--format json` for machine-readable state. A service failure makes analysis incomplete; it is never silently retried through another executor.

`init` supports `--profile fast|recommended|thorough`, `--hook auto|husky|lefthook|simple-git-hooks|raw|none`, `--checks <comma-separated IDs>`, `--osv-unavailable block|warn`, `--yes`, and text/JSON output. Interactive setup exposes the same check toggles and OSV outage choice without requiring documentation lookup. `scan`, `checks`, and `doctor` accept `--config <path>`.

Bare `zedbee fix` selects `formatting`, `lint`, and `reactCorrectness`; a named
selector limits the plan to that supported check. Interactive terminals preview
and request confirmation. Redirected and JSON use is preview-only unless
`--yes`, the automation approval flag, is present. Managed lint and React fixes
apply only exact reported official fixes; selected Prettier formatting runs
after them over each complete current working file, including unstaged work.
Warnings and blockers are both eligible. Suggestions and unsupported checks
remain manual. Review, stage, and rescan after applying; see the
[complete managed-fix contract](docs/managed-fixes.md).

`zedbee doctor` defaults to responsive automatic output. Doctor uses the yellow Zedbee frame with one full-width `DOCTOR` panel in a wide interactive terminal. A narrow terminal, redirected output, CI environment, or `TERM=dumb` receives compact plain text instead. `zedbee doctor --format text` always forces the plain view, while `zedbee doctor --format json` is deterministic and ANSI-free. `--no-color` keeps an eligible framed layout but removes semantic status colors.

`zedbee checks` uses the same responsive behavior. Checks uses the yellow Zedbee frame with one full-width `CHECKS` panel in a wide interactive terminal, showing each check's severity, applicability, engine, targets, execution details, network use, and limitations. `zedbee checks --format text` forces the complete plain view, while `zedbee checks --format json` keeps the existing deterministic, ANSI-free machine output. Narrow terminals, redirected output, CI, and `TERM=dumb` use plain text; `--no-color` keeps an eligible framed layout without semantic colors.

## Experimental programmatic API

Zedbee's supported v1 interface is its command-line interface. The package also exports TypeScript and JavaScript functions for programmatic use, but that API is experimental: its names, types, and behavior may change between releases without the normal compatibility guarantees. Do not build a production integration around it yet. Feedback about intended API uses is welcome; see the package exports and generated declarations for the current surface.

`runScan({ repositoryRoot })` owns and closes a local executor. It does not start the CLI service. An explicit executor can be reused across calls; each call still captures a fresh source epoch, closes its own session, and preserves configuration, attribution and cache validation. The caller must close the executor, including after cancellation or errors:

```js
import { createLocalAnalyzerExecutor, runScan } from "zedbee";

const executor = createLocalAnalyzerExecutor({ concurrency: 2 }); // 1, 2 or 4
try {
  const first = await runScan({ repositoryRoot, executor, cache: false });
  const second = await runScan({ repositoryRoot, executor, cache: false });
  // Inspect each report's outcome/exitCode; incomplete is never a clean scan.
} finally {
  await executor.close();
}
```

`cache: false` disables observation reuse, independently of engine reuse. An executor has bounded session/job admission; `AnalyzerCapacityError` reports overload. It does not grant permission to replay accepted analysis. Ordinary scans submit bounded work across large workspace sets. Concurrent embedding callers must bound their own scans and handle admission failures. Never delete temporary snapshots after an unproved cleanup failure; follow the reported cleanup guidance.

## Exact selected content

Zedbee treats the Git index as the proposed commit. If you stage a file and edit it again without staging the later edit, Zedbee scans the staged version. It materializes isolated baseline and target snapshots by reading the selected Git blobs directly, without checkout EOL conversion, smudge/process filters, or Git LFS materialization, and cleans them after proving execution has stopped. Unproved cleanup retains the snapshots and makes the scan incomplete. Source excerpts therefore come from the exact selected object bytes and line, never from a later working-tree edit.

A bare `zedbee scan`, along with `zedbee fix` and `zedbee checks`, reads repository configuration from the Git index. `zedbee scan --base <ref>` instead reads it from the committed target `HEAD`. In index mode, a newly staged `.zedbeerc.jsonc` takes effect immediately, while an unstaged or untracked copy cannot weaken the policy applied to staged code; when the selected source has no configuration, Zedbee uses the recommended defaults. `zedbee init` and `zedbee doctor` still inspect the working copy because they create or diagnose local configuration rather than judge a proposed commit.

### Committed branch scans in CI

An ordinary `zedbee scan` examines the Git index. A clean pull-request checkout therefore has zero index changes; it does not automatically scan the commits on the checked-out branch. Fetch the base branch history and request committed base mode explicitly:

```sh
git fetch --no-tags origin main
npx zedbee scan --base origin/main --format sarif > zedbee.sarif
```

`--base <ref>` resolves the unique merge base of the locally available ref and committed `HEAD`, then scans only the committed changes from that merge base through `HEAD`. If the base branch advances after the feature branch splits, base-only commits are not treated as feature changes. The named ref and enough common history must already exist locally. Zedbee never fetches automatically; a shallow checkout without the required ancestry is incomplete and exits 2, so configure sufficient fetch depth or fetch more history before retrying.

Base mode is immutable by design. Both snapshots and `.zedbeerc.jsonc` come from commits: the target policy is read from `HEAD`, while staged, unstaged, and untracked source edits are ignored. The command does not change `HEAD`, refs, the index, or the working tree. It cleans its temporary committed-tree snapshots after success, failure, timeout, or cancellation once execution cleanup is proved; otherwise it retains them and reports incomplete. `zedbee fix --base` does not exist because managed fixes write reviewed working files from the staged-index workflow; a committed CI comparison is an inspection target, not a mutable fix target.

In index mode, an intent-to-add entry (`git add --intent-to-add`) supplies no staged file content and is excluded as unstaged. Git LFS pointers and submodule pointers in either the selected index or committed target cannot be inspected, so Zedbee reports every affected path as incomplete. Binary assets remain allowed, but a binary file whose path is selected by an enabled source, formatting, or vulnerability check is incomplete rather than silently skipped. Intentional per-path suppressions are configured with `pathExclusions`.

An analyzer may inspect a whole file or project when correctness requires it. Zedbee separately attributes the result and reports only issues introduced or worsened by the selected target changes.

## Configuration

The optional root configuration is `.zedbeerc.jsonc`. It is data, not executable project code.

```jsonc
{
  "$schema": "./node_modules/zedbee/schema/zedbee.schema.json",
  "schemaVersion": 1,
  "profile": "recommended",
  "checks": {
    "formatting": {
      "severity": "error",
      "settings": {
        "printWidth": 100,
        "singleAttributePerLine": true,
        "singleQuote": true,
      },
    },
    "lint": { "rules": { "no-console": "warn" } },
    "cyclomaticComplexity": { "max": 20, "blockWorsening": true },
    "readabilityComplexity": { "max": 15, "blockWorsening": true },
    "duplication": {
      "threshold": 5,
      "settings": { "minLines": 5, "minTokens": 50, "mode": "mild" },
    },
    "reactCorrectness": { "rules": { "react/prop-types": "off" } },
    "reactAccessibility": {
      "rules": { "jsx-a11y/no-autofocus": "warn" },
    },
    "vulnerabilities": { "severity": "error", "onUnavailable": "block" },
  },
  "overrides": [
    {
      "files": ["**/*.test.{ts,tsx}"],
      "checks": {
        "lint": { "rules": { "no-console": "off" } },
        "formatting": { "settings": { "printWidth": 88 } },
      },
    },
  ],
  "pathExclusions": [
    {
      "files": ["**/*.snap", "coverage/**"],
      "checks": ["formatting", "lint", "types"],
      "reason": "Known snapshot and generated files are intentionally excluded.",
    },
  ],
  "reporting": {
    "sourceExcerpts": "interactive",
    "terminalFindingLimit": 25,
    "temporaryReportMaxAge": "24h",
    "agentGuidance": {
      "opening": "Use the complete report as the source of truth.",
      "nextStep": "Fix every blocking finding, then run Zedbee again.",
    },
  },
  "failOnIncomplete": true,
}
```

Profiles are `fast`, `recommended`, and `thorough`. A check can use severity `off`, `warn`, or `error`, and timing `relevant` or `always`. Exactly seven configurable checks expose additional managed settings: `formatting`, `lint`, `cyclomaticComplexity`, `readabilityComplexity`, `duplication`, `reactCorrectness`, and `reactAccessibility`. The complete option tables, defaults, rule boundaries, and override examples are in the [check guide](docs/checks.md).

Overrides are evaluated in array order for each repository-relative file. Every matching patch is applied, and a later matching override takes precedence for the fields it supplies. This is true per-file behavior: two selected target files in the same workspace can receive different formatting, rule, complexity, severity, and timing policy. Duplication is the exception because jscpd compares a workspace as a whole; its `threshold`, `minLines`, `minTokens`, and `mode` settings are workspace-wide and are rejected in file overrides.

`pathExclusions` suppresses named checks for exact files or directory globs. Each entry must include at least one repository-relative path, at least one check ID, and a short reason. Exclusions are applied after file overrides, so a matching exclusion always wins for the named checks. Patterns use forward slashes and support ordinary `*`, `**`, and `?` matching; absolute paths, parent traversal, negation, braces, and extended globs are rejected. Other checks still inspect the path. JSON reports include the configured exclusions and identify the ones that matched the selected changes.

Run `zedbee checks` to inspect effective settings, their profile or repository source, and configured file overrides without running analysis. Use `zedbee checks --format json` for the complete machine-readable view. `zedbee init` deliberately writes only the selected profile/checks and existing guidance; the shipped editor schema, this documentation, and `zedbee checks` are the settings discovery surface.

`reporting.sourceExcerpts` accepts `never`, `interactive`, or `always` and defaults to `interactive`. `never` omits ordinary source from every format, `interactive` includes it only in Ink, and `always` includes it in Ink, text, JSON, and SARIF. An explicit `--include-source` or `--no-source` overrides repository policy for that scan.

The configuration example is illustrative. `zedbee init` writes editable recommended guidance. `opening` and `nextStep` can be blanked independently with `""` to hide only that message. The fixed complete-report lines remain when a configured message is blank.

`reporting.terminalFindingLimit` defaults to 25 findings for automatic terminal output and forced `--format ink`; set it to a positive integer or `"all"`. The limit applies to findings only, with blockers first. Counts, disclosures, incomplete checks, report warnings, guidance, and report paths are never limited. Automatic scans always save a complete versioned JSON report, including passes with zero findings. `reporting.temporaryReportMaxAge` defaults to `"24h"`. Temporary reports become eligible for cleanup at the configured age and are removed during a subsequent Zedbee maintenance run. The operating system may remove them sooner. These handoffs are not archives.

The versioned editor schema ships at `node_modules/zedbee/schema/zedbee.schema.json`. `zedbee init` writes that local schema reference, so validation does not depend on a website being available.

## Managed analyzer boundary

Zedbee ships and pins Prettier 3.9.6, ESLint 9.39.5, typescript-eslint 8.67.0, TypeScript 6.0.3, Secretlint 13.0.5, eslint-plugin-react 7.37.5, eslint-plugin-react-hooks 7.1.1, eslint-plugin-jsx-a11y 6.10.2, ast-grep 0.45.1, jscpd 5.0.15, Dependency Cruiser 18.2.0, and Knip 6.32.2. It supplies its own inert analyzer configuration and never loads project ESLint, Prettier, Secretlint, Babel, parser, plugin, or executable analyzer configuration. Rule options follow the analyzer and plugin versions pinned by the installed Zedbee release. Only bundled rules can be configured; custom plugins cannot be loaded. TypeScript configuration is parsed as selected snapshot data, not executed; installed declaration packages may be resolved through the constrained project `node_modules` boundary. Typed lint loads every contained `tsconfig*.json` in an inspected workspace and uses each project for the files it covers. By default, a TypeScript file outside every loaded project makes typed lint incomplete. This avoids validating changed target code under unrelated compiler settings.

Zedbee does not load any native analyzer config files, including native Prettier and ESLint configs. Adoption therefore has a deliberate tradeoff: teams with native configs may see different Zedbee results because those files are not loaded. Re-express the supported policy in `.zedbeerc.jsonc`, within Zedbee's bounded managed settings, rather than expecting native configuration parity.

Project checks inspect a workspace as a whole, then compare the isolated selected baseline and target snapshots so existing debt remains non-blocking. This roughly doubles analyzer work. Zedbee runs Knip in a fresh internal worker for each snapshot side, using a captured filesystem shared by Knip and its pinned Oxc WebAssembly resolver. Framework plugins and executable project configs remain disabled. Dynamic imports, framework conventions, wildcard package exports, and TypeScript path aliases may need future managed profiles. Package import aliases (`#name`) in the selected `package.json` are supported, including exact mappings, wildcard mappings, conditions, and fallback arrays. They use the nearest package manifest and the same scan boundary as other imports: an alias cannot bypass checks against installed packages outside the snapshot inventory. Missing aliases remain normal Knip findings; unsafe targets make the dead-code check incomplete. Knip findings can be cached when complete input metadata is available, including the absence checks that protect package resolution. jscpd runs as a subprocess and receives an exact source-file list; exceptionally large workspaces can exceed the operating system argument limit and fail incomplete. Dependency Cruiser runs through its public API.

React correctness runs for React, React DOM, Ink, Next.js, and Remix. DOM accessibility runs only when inspection finds React DOM, Next.js, or Remix, so Ink terminal components do not receive browser-DOM advice. For each baseline and target workspace, React correctness calibrates version-sensitive rules from that snapshot's direct manifest declaration and, when available, an unambiguous matching record in a supported lockfile. It falls back silently to the manifest and then Zedbee's managed React 19.2 baseline; developers do not need to edit lockfiles for Zedbee. The managed plugins never use `detect` mode or load project `node_modules`. See the [React analysis policy](docs/react-analysis.md).

Zedbee Readability Complexity is an original metric, not Sonar Cognitive Complexity, and teams migrating from Sonar must recalibrate thresholds. The built-in structural-security rules are deliberately narrower than Semgrep: they have no dataflow, taint, interfile analysis, reachability, framework packs, or live rule registry. See [the readability scoring contract](docs/readability-complexity.md), [React analysis policy](docs/react-analysis.md), and [structural-security coverage](docs/structural-security-coverage.md).

Use another repository-contained JSONC file when needed:

```bash
npx zedbee scan --config config/zedbee.jsonc
```

## Output

```text
--format auto   Branded Ink in a wide interactive terminal; linear ANSI-free text otherwise
--format ink    Live Ink progress and the compact Zedbee result
--format text   Stable human-readable output
--format json   Versioned structured output for CI and agents
--format sarif  SARIF 2.1.0 structured output for enterprise ingestion
```

Accessibility controls:

```bash
npx zedbee scan --no-color
npx zedbee scan --no-animations
NO_COLOR=1 npx zedbee scan
```

Status always includes labels or symbols in addition to color. Animated Ink scans remain visible for at least 400ms so the transition can be perceived; `--no-animations` bypasses that minimum instead of adding a delay. A configurable display delay is deferred beyond v1. Text and JSON output contain no terminal animation, delay, or logo control sequences.

Source excerpt controls:

```bash
npx zedbee scan --include-source
npx zedbee scan --no-source
```

Ordinary selected target source may be visible in interactive Ink by default to the human or agent that invoked Zedbee. Text, JSON, and SARIF source is opt-in with `--include-source` unless repository policy is `always`. Excerpts come only from the exact selected target—the Git index in index mode or committed `HEAD` in base mode; secret findings are always redacted regardless of policy or CLI override.

Redirect complete stable reports with normal shell redirection:

```bash
npx zedbee scan --format text > zedbee-report.txt
npx zedbee scan --format json > zedbee-report.json
npx zedbee scan --format sarif > zedbee.sarif
npx zedbee scan --format text --include-source > zedbee-report-with-source.txt
```

Automatic scans use branded Ink in a wide ordinary TTY. Narrow terminals, redirected output, CI, `TERM=dumb`, and screen-reader output use a linear ANSI-free result. Every automatic scan writes a complete versioned temporary JSON report, even on pass with zero findings. Its path appears in the opening and closing complete-report lines around the final result, and only after the file exists. Fixing only the visible preview is insufficient—process every finding in the complete report.

Automatic output and explicit `--format ink` show at most `reporting.terminalFindingLimit` findings; blockers appear first. Explicit Ink writes a temporary report only when its finding preview overflows. If an automatic or overflowed Ink report cannot be retained safely, Zedbee shows every finding, omits report paths and configured guidance, preserves the canonical scan outcome, and prints the fixed `REPORT UNAVAILABLE` alert at both the top and bottom. Any `REPORT DELIVERY WARNING` is a detail panel, not that fixed alert.

Explicit `--format text`, `--format json`, and `--format sarif` output remains complete, has no finding cap, and writes no sidecar. Redirect an explicit format when you need a durable saved location. SARIF is the complete, deterministically ordered enterprise export and retains Zedbee's normal exit status. See the [reporting guide](docs/reporting.md) for the full contract, including incomplete-scan notifications, retention, and source-excerpt behavior.

For coding tools and CI, prefer `zedbee scan --format json` or `zedbee scan --format sarif` when the receiving system ingests SARIF. Both are versioned, deterministically ordered, ANSI-free, repository-relative, and include stable finding IDs, attribution evidence, incomplete states, and network disclosures. When automatic output provides a complete report path, coding tools must process that file rather than only the preview. They must respect exit code 2 as unknown/incomplete—not as a clean scan—and should never bypass the hook merely because a finding is not automatically fixable.

## Exit codes

| Code | Scan meaning                                            | Managed-fix meaning                                                                                    |
| ---: | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
|  `0` | Scan completed with no blocking findings                | Preview/cancel made no writes, or every approved file operation completed without an issue             |
|  `1` | Scan completed and repository policy blocked the commit | Partial completion: safe files may be applied while skipped fixes and their reasons are reported       |
|  `2` | Zedbee or an enabled check could not complete           | The current staged code could not produce a trustworthy complete fix plan, so the plan was not applied |

Interrupted scans wait for execution cleanup before removing temporary snapshots and returning the platform's conventional interruption status. Unproved cleanup retains snapshots and reports the cleanup failure.

## Hooks

`zedbee init --hook auto` detects Husky, Lefthook, simple-git-hooks, or raw Git hooks. It preserves unrelated commands, shows exact before/after hashes and diffs, refuses symlink targets, writes atomically, and rolls back earlier writes if a later write fails. Linked worktrees resolve the real Git hook path instead of assuming `.git` is a directory.

Generated hooks run `npx --no-install zedbee scan`. This prevents an unexpected network download during a commit, but it means Zedbee must remain installed in the project. Run `zedbee init` again to preview an idempotent update; an existing Zedbee invocation is not duplicated.

## Cache and performance

Zedbee may cache content-addressed, normalized observations for audited local analyzers. Cache keys include source mode, the exact baseline and target identity, snapshot inventories, policy, workspace/config inputs, installed engine package identities, and runtime platform. TypeScript and lint capture their dependency files and resolution state; Knip captures its permitted snapshot inputs and package-absence guards. These inputs are checked again before saved findings are reused. Incomplete metadata prevents saving or reusing a result, and unknown checks default to uncached. Missing engine package metadata, cache failures, and corruption are misses and never reduce coverage. Source, raw analyzer output, Secretlint observations, OSV results, secrets, and online response bodies are never stored in the observation cache. Cached and uncached reports are required to remain semantically identical.

Scan time depends on project size, enabled checks, baseline comparison, and validated cache reuse. A running service does not mean every analyzer remains loaded: some engines retire after a session or snapshot side. These lifecycle choices do not guarantee faster scans. See [safe analyzer diagnostics](docs/reporting.md#safe-analyzer-diagnostics) to investigate a slow or incomplete job.

## Current coverage

The managed suite currently includes:

1. Prettier formatting, ESLint and typescript-eslint lint, TypeScript diagnostics, both complexity metrics, original ast-grep security checks, React correctness, and React DOM accessibility.
2. jscpd duplication, Dependency Cruiser architecture validation, and Knip dead-code/package-hygiene analysis across npm, pnpm, Yarn, and Bun workspaces.
3. Exact index or committed snapshots, baseline comparison, changed-range and syntax-entity attribution, stable text/JSON output, and the live Ink progress display.
4. Direct Secretlint scanning with irreversible redaction, plus the bounded Zedbee OSV API client for disclosed online vulnerability comparison.

Optional Semgrep is not part of the v1 managed suite and is not silently approximated by the current structural rules. Online vulnerability scanning sends package names, exact versions, and the npm ecosystem identifier to `api.osv.dev`; source code and file hashes are not sent. There is no offline database mode. Choose whether an OSV outage blocks or warns with `checks.vulnerabilities.onUnavailable` or guided `zedbee init`.

See [the complete check matrix](docs/checks.md), [support matrix](docs/support.md), [privacy and data handling](docs/privacy.md), and [security policy](SECURITY.md).

## Troubleshooting

- Run `npx zedbee doctor` first; JSON mode is useful when sharing sanitized diagnostics.
- Exit code 2 means a required result is incomplete. Resolve the diagnostic rather than treating it as a pass.
- For a snapshot cleanup failure, resolve the reported execution/cleanup problem before removing retained snapshots. Inspect the exact listed Zedbee temporary directory when one is safely validated. If no path is listed, inspect the OS temporary directory for stale `zedbee-snapshot-*` directories. Correct temporary-directory permissions, locks, or filesystem problems before retrying; persistent problems can leave additional snapshots on later scans.
- Typed lint checks unchanged workspace source files too, using each snapshot's contained TypeScript projects. In each snapshot, every TypeScript file selected for typed lint must belong to at least one loaded project. Updating only the selected target configuration may leave the baseline snapshot uncovered.
- For files intentionally outside every TypeScript project, a file override can set `checks.lint.typeInformation` to `"when-available"`. Zedbee then runs basic TypeScript lint without rules that require type information. The default is `"required"`; Zedbee never reduces coverage silently.
- Intent-to-add entries are excluded from index mode as unstaged. Git LFS pointers, submodule pointers, and binary inputs selected by enabled text/source checks remain incomplete in either source mode with every affected path reported; use `pathExclusions` to intentionally suppress paths for specific checks.
- OSV connectivity failures follow `checks.vulnerabilities.onUnavailable`: `block` fails closed, while `warn` reports the incomplete check and permits the commit if nothing else blocks.
- If a hook cannot find Zedbee, restore the project-local dev dependency; generated hooks deliberately use `npx --no-install`.
- pnpm and modern Yarn lockfiles that use YAML alias references (including anchor-based reuse) make vulnerability analysis incomplete. Zedbee deliberately disables alias expansion to keep lockfile parsing bounded. Regenerate the lockfile with the package manager rather than hand-authoring reusable YAML nodes.
- If a repository commits a package beneath `node_modules` and source code imports it, managed Knip analysis is incomplete. Zedbee refuses to let snapshot-controlled packages participate in analyzer module resolution; remove the committed package and restore dependencies through the package manager and lockfile.
- Very large jscpd source lists can exceed the operating system argument limit, and framework-heavy Knip projects may need future managed profiles. Both cases are reported rather than silently skipped.

## License

Zedbee is distributed under the [PolyForm Small Business License 1.0.0](https://polyformproject.org/licenses/small-business/1.0.0). The npm SPDX identifier is `PolyForm-Small-Business-1.0.0`. See [LICENSE](LICENSE) for the complete terms.

PolyForm applies to Zedbee's own code, including its OSV API client. npm dependencies retain their separate licenses; Secretlint is distributed under MIT terms. Uses outside PolyForm's permissions require separate terms from the licensor. To discuss a commercial license, email [licensing@zedbee.dev](mailto:licensing@zedbee.dev). See [commercial use and third-party licensing](docs/commercial-licensing.md). This documentation is not legal advice; commercial distribution should receive qualified legal review.
