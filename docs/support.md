# Support Matrix

This document distinguishes implemented coverage from unsupported or deferred behavior. `zedbee checks --format json` is the machine-readable view of the current repository's configured checks and applicability.

## Runtime and project support

| Area              | Supported                                                                                                     | Notes                                                                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | Node.js 22.13.0 and newer                                                                                     | CI verifies current Node 22 and 24 releases.                                                                                                                                                                                       |
| Operating systems | Linux, macOS, and Windows                                                                                     | CI runs the core suite on hosted runners for all three systems. Native npm dependencies must provide an artifact for the user's platform.                                                                                          |
| Source            | `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts`                                                  | Zedbee targets JavaScript and TypeScript initially.                                                                                                                                                                                |
| Workspaces        | npm, pnpm, Yarn, and Bun JavaScript workspaces                                                                | Discovery uses manifests and workspace declarations from each selected snapshot without running lifecycle scripts.                                                                                                                 |
| React             | React, React DOM, Ink, Next.js, and Remix correctness                                                         | DOM accessibility runs only for React DOM, Next.js, and Remix—not Ink. React correctness calibrates each snapshot/workspace from that snapshot's dependency data.                                                                  |
| Git input         | Exact staged index against committed `HEAD`, or explicit committed `HEAD` comparison with `scan --base <ref>` | Base mode uses the unique merge base and locally available history. Intent-to-add entries are excluded from index mode. LFS pointers, submodules, and relevant binary text/source inputs report every affected path as incomplete. |

## Dependency vulnerability inventories

| Package manager | Supported lockfile    | Status                                                                     |
| --------------- | --------------------- | -------------------------------------------------------------------------- |
| npm             | `package-lock.json`   | Supported lockfile versions are parsed locally.                            |
| npm             | `npm-shrinkwrap.json` | Supported lockfile versions are parsed locally.                            |
| pnpm            | `pnpm-lock.yaml`      | Parsed locally with bounded YAML input.                                    |
| Yarn Classic    | `yarn.lock`           | Parsed locally through the pinned `@yarnpkg/lockfile` package.             |
| Bun             | `bun.lock`            | The text lockfile is parsed locally.                                       |
| Bun legacy      | `bun.lockb`           | The binary format is not supported. Generate and stage `bun.lock` instead. |

Text lockfiles are limited to 8 MiB and are rejected before an oversized body is loaded into memory. Parsed structure, nesting, strings, dependency records, and OSV query counts have additional fixed safety limits. pnpm and modern Yarn YAML alias references—including anchor-based reuse—are deliberately rejected rather than expanded, so the vulnerability check reports incomplete. Regenerate the lockfile with the package manager instead of hand-authoring reusable YAML nodes.

React correctness can also use these supported lockfiles to refine a
workspace's direct `react` declaration in each selected snapshot. It uses only
an unambiguous, compatible record associated with that workspace; monorepo
sibling records do not qualify. Missing, unsupported, unreadable, or ambiguous
lockfile data falls back silently to that snapshot's manifest version and then
Zedbee's managed React 19.2 baseline. Users do not need to change a lockfile for
React calibration.

## Project-analysis resolution boundary

Managed Knip analysis does not permit an imported package beneath `node_modules` to be supplied by a selected snapshot or by an ancestor directory. This prevents repository-controlled package code from entering analyzer module resolution. A repository that commits such a package receives an incomplete `deadCode` result; remove the committed package and restore dependencies through the package manager and lockfile. Ordinary ignored, locally installed dependencies remain supported.

React calibration likewise does not use plugin `detect` mode and never loads
project `node_modules`; it parses package manifests and supported lockfiles from
each selected snapshot instead, so it does not execute project React code.

## Managed configuration compatibility

Scan and fix analyzer jobs run in fresh child processes with bounded concurrency.
Zedbee supervises their descendants and waits for cleanup before releasing the
job. Cancellation stops active analysis; a worker crash or invalid response makes
the affected check incomplete. This process isolation is not an operating-system
sandbox. The processes retain the user's permissions, and the managed
configuration and input-resolution boundaries below remain necessary.

The CLI still performs orchestration, configuration validation, snapshot
inspection, attribution, reporting, and safe file writes. `doctor` also uses a
built-in Secretlint readiness probe. Process isolation describes scan/fix analyzer
execution, not every use of analyzer-related metadata in the CLI.

Fresh jobs do not retain analyzer instances, parsed source, or TypeScript programs
between jobs. This releases their process memory after completion and adds
startup work to each job; it is not a guarantee of faster scans. Normalized
observation caching is limited to audited snapshot-only inputs. TypeScript,
lint, and dead-code results bypass that cache because local dependency resolution
can affect them. Source, raw engine output, secrets, Secretlint observations,
OSV results, and online response bodies are never cached.

Zedbee does not load a project's native analyzer config. Prettier, ESLint, React, Hooks, and JSX accessibility behavior comes from Zedbee's managed settings and bundled rules; custom plugins and executable project configuration are outside the supported boundary. Rule options follow the analyzer and plugin versions pinned by the installed Zedbee release and can change when Zedbee upgrades its managed engines. `zedbee checks` displays effective settings and a primary managed engine summary, not every supporting package version.

This boundary is an adoption tradeoff: teams with native configs may see different Zedbee results because those files are not loaded. Configure supported differences in `.zedbeerc.jsonc` and use the shipped schema for editor validation. `zedbee checks` shows the effective settings, profile or repository source, and ordered overrides without running analysis.

Formatting, lint, both complexity checks, React correctness, and React accessibility can resolve settings independently per file. Later matching overrides take precedence for the fields they supply. Duplication thresholds and clone settings remain workspace-wide because clone detection compares the workspace as a whole.

## CI branch comparisons

CI systems commonly provide a clean checkout whose Git index matches `HEAD`. In that checkout, ordinary `zedbee scan` correctly reports zero index changes; it does not infer a pull request or discover a provider-specific base branch. Fetch the intended base ref and invoke committed base mode explicitly:

```sh
git fetch --no-tags origin main
npx zedbee scan --base origin/main --format sarif > zedbee.sarif
```

Zedbee resolves the unique merge base between `origin/main` and committed `HEAD`, then scans the committed merge-base-to-`HEAD` change. The base ref and sufficient common ancestry must already be present. Zedbee does not fetch, deepen, or unshallow the repository. Missing shallow history returns an incomplete report and exit code 2 without changing the checkout; fetch more history and retry.

Base mode reads configuration and source only from the committed target tree. Staged, unstaged, and untracked files do not participate, and no base-mode command changes the index, working tree, `HEAD`, or refs. There is intentionally no `fix --base`: the comparison describes immutable commits, while managed fixes operate on reviewed working files in the staged-index workflow.

When enabled, vulnerability analysis sends package name, exact version, and the npm ecosystem identifier to `api.osv.dev`. It is online only. Configure `checks.vulnerabilities.onUnavailable` as `block` or `warn`; `zedbee init` presents that choice and its disclosure.

## Secret scanning inputs

Secretlint scans non-deleted changed files from both selected snapshots: committed `HEAD` and the exact index in index mode, or the resolved merge base and committed `HEAD` in base mode. Regular UTF-8 text files up to 1 MiB are supported. Binary files containing NUL bytes are skipped. Invalid UTF-8, oversized files, missing required snapshot content, and symbolic links make the secret check incomplete with the affected repository-relative path and remediation. Other Git history is not scanned.

Secret findings and overlapping source excerpts are always redacted. Zedbee never loads project Secretlint configuration.

## Reports and automation

Ink is the interactive human interface. Automatic scans always write a complete versioned JSON report to protected operating-system temporary storage, even for passes with zero findings, and print its path before and after the final result. Wide ordinary TTY output is branded Ink; narrow, redirected, CI, `TERM=dumb`, and screen-reader automatic output is linear and ANSI-free. The 25-item default limits findings only and prioritizes blockers first for automatic output and explicit `--format ink`. Counts, disclosures, incomplete checks, warnings, guidance, and paths are never limited. Explicit Ink writes a report only when its finding preview overflows. `reporting.terminalFindingLimit: "all"` disables abbreviation. The default `temporaryReportMaxAge` is `"24h"`. Temporary reports become eligible for cleanup at the configured age and are removed during a subsequent Zedbee maintenance run. The operating system may remove them sooner. These handoffs are not archives.

Stable text, versioned JSON, and SARIF 2.1.0 are suitable for redirection, coding tools, and CI. Every explicit text, JSON, and SARIF export is complete: it includes every finding and incomplete-scan notification, has no finding cap, and writes no sidecar. Durable JSON or SARIF requires explicit output/redirection. Forced Ink remains a bounded preview rather than a complete export.

```bash
npx zedbee scan --format text > zedbee-report.txt
npx zedbee scan --format json > zedbee-report.json
npx zedbee scan --format sarif > zedbee.sarif
```

SARIF remains non-interactive and retains the normal scan exit status: exit code 0 allows the proposed change, 1 indicates completed blocking findings, and 2 indicates incomplete required analysis. An OSV outage configured as `warn` remains visible as incomplete but does not by itself block. Terminal presentation and explicit exports have separate contracts, so terminal finding limits never abbreviate explicitly requested text, JSON, or SARIF.

Coding tools must process the complete report path and respect exit code 2 as incomplete—not clean. Fixing only the visible preview is insufficient. The path appears only after the report exists completely. Cleanup and write warnings are non-blocking maintenance diagnostics; a report failure, including a write failure, restores full terminal output with all findings, provides no false path or configured guidance, preserves the canonical scan outcome, and prints fixed `REPORT UNAVAILABLE` alerts twice. Each fixed alert confirms that nothing was hidden and all findings are shown above. `REPORT DELIVERY WARNING` is a detail panel for report-maintenance information, not the fixed failure alert. Automatic reports use the disk source-excerpt policy: default interactive excerpts are omitted from the file unless `reporting.sourceExcerpts` is `always` or `--include-source` is used; secret content remains redacted.

## Managed fixes

Managed fix support is limited to complete-file Prettier formatting and exact
reported official fixes from `lint` and `reactCorrectness`. Suggestions and all
other checks are manual. `zedbee fix` never stages or commits.

A managed fix conflict skips the affected file while partial progress continues
on independent safe files and returns a nonzero result. Stale previews,
overlapping exact edits, formatting failures, safe-write failures, and
durability uncertainty are also reported. A file replacement whose directory
durability could not be confirmed is not safe to retry automatically. Review
every changed and skipped file, stage intended results, and rescan.

## Not currently supported

- Semgrep-compatible taint, interfile, reachability, framework-pack, or live-registry analysis;
- Git-history secret scanning;
- an offline OSV database;
- legacy binary `bun.lockb` vulnerability parsing;
- automatic staging, committing, or mutation of the Git index.
