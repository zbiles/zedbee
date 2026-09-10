# Security Policy

## Supported versions

The following release line receives security fixes:

| Version line | Security fixes |
| ------------ | -------------- |
| `0.1.x`      | Supported      |

Published `0.1.x` prereleases are included. Unpublished development snapshots have no guaranteed support; reproduce a report against the latest published `0.1.x` release when possible.

## Reporting a vulnerability

Email security reports to [security@zedbee.dev](mailto:security@zedbee.dev). Do not include credentials, proprietary source code, or other live secrets in a public issue or initial email. Include only the smallest synthetic reproduction needed to explain the issue. The project owner may arrange a safer private transfer method if more information is required.

A useful report identifies the affected Zedbee version or commit, platform, security boundary, expected behavior, observed behavior, and a synthetic proof of concept. Reports about a third-party analyzer should also name its package and pinned version.

## Security boundaries

Zedbee treats repository content and analyzer output as untrusted. Ordinary scans analyze isolated snapshots of committed `HEAD` and the Git index; `scan --base <ref>` uses the unique merge base and committed `HEAD`. Selected source and scan configuration come from those snapshots, not later working-tree edits. Managed analyzers use inert configuration and library APIs where available; remaining managed subprocesses run without a shell. Zedbee does not execute project analyzer configuration, project commands, or package-manager lifecycle scripts.

Scan and fix analysis uses fresh sessions in supervised workers that may be reused by a private local service. This is process isolation, not an operating-system sandbox: the service and workers retain the invoking user's permissions. Session release clears source/project state; engines that require retirement exit before their snapshots can be removed.

The selected-source boundary permits these additional local reads:

- TypeScript and typed lint can capture dependency inputs through constrained installed-package and bundled TypeScript resolution boundaries. Those bytes support analysis; they are not selected repository changes or persisted source-cache entries.
- Managed fix previews read current working files, including unstaged edits. Exact lint and React edits must not overlap unstaged work; selected formatting intentionally formats the complete current working file. Applying a fix requires interactive confirmation or `--yes`, and writes working files only. Zedbee never stages or commits.
- `init` and `doctor` inspect working-copy configuration for setup and diagnostics.

Ordinary source excerpts may be displayed according to `reporting.sourceExcerpts` and CLI overrides. Interactive Ink includes them by default; explicit text, JSON, SARIF, and automatic saved reports omit them by default. Detected secret findings and overlapping excerpt lines are redacted regardless of source policy. Detection is not exhaustive; use `--no-source` when ordinary source must not appear. Raw analyzer reports and detected secret values must not enter public findings or the observation cache.

Automatic scans retain complete reports in protected OS temporary storage. By default they become eligible for cleanup after 24 hours and are removed during a subsequent maintenance run; this is not a guaranteed deletion deadline. Explicit JSON or SARIF exports are user-managed. Validated report paths are intentionally shown so users can open reports.

Snapshot deletion waits for proof that analysis has stopped, including after failure, timeout, or cancellation. If execution cleanup cannot be proved, snapshots remain and the scan is incomplete. Cleanup diagnostics may disclose a safely validated managed temporary path for recovery; report cleanup warnings are non-blocking. Do not remove retained snapshots until the reported execution/cleanup problem is resolved. See [privacy and data handling](docs/privacy.md) for retention, cache, service, and network details.

The following are security bugs and should be reported:

- using unstaged or out-of-snapshot repository source as selected scan input, or escaping the documented dependency/fix read boundaries;
- exposing detected secret content or raw analyzer reports, bypassing source-excerpt policy, or leaking unvalidated or unrelated absolute paths;
- running an online check without its disclosure and configured network policy;
- loading project Secretlint, ESLint, Prettier, or other executable analyzer configuration;
- executing package-manager lifecycle scripts, project commands, or project analyzer configuration;
- following a selected repository symlink outside the protected snapshot;
- silently passing when a required check cannot complete.

Zedbee does not claim that static analysis finds every vulnerability. Its structural rules are narrower than Semgrep and do not provide general interfile dataflow, taint, reachability, or framework-pack analysis.
