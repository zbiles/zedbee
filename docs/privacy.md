# Privacy and Data Handling

## Local snapshot processing

Index mode materializes two temporary representations: committed `HEAD` and the exact staged Git index. It does not scan later unstaged working-tree edits. Source excerpts are read from that exact index snapshot, so an excerpt cannot be replaced by later working-tree content. An intent-to-add entry supplies no staged file content and is excluded as unstaged. Staged Git LFS pointers and submodule pointers cannot be inspected and make the scan incomplete. Binary assets remain allowed, but binary paths selected by enabled source, formatting, or vulnerability checks are incomplete rather than silently skipped. Every affected path is reported; intentional suppression is configurable with `pathExclusions`.

Explicit base mode (`scan --base <ref>`) instead materializes the unique merge-base commit and committed `HEAD`. Source, configuration, and excerpts come only from those immutable commit trees; staged, unstaged, and untracked checkout content is not read as scan input. The base ref and common history must already be available locally. Zedbee performs no automatic network fetch, and missing shallow ancestry produces an incomplete result with exit code 2.

Snapshot paths are validated under a Zedbee-owned temporary directory, staged links may not escape it, and cleanup runs before the command returns. Cleanup failure is itself an incomplete scan and may disclose one validated Zedbee temporary directory so the invoking human or agent can inspect and remove exactly what remains. If Zedbee cannot safely validate the directory's identity, it reports no path and instead directs the operator to inspect the OS temporary directory for stale `zedbee-snapshot-*` directories. Correct permissions, locks, or filesystem problems before retrying: a persistent cause can make later cleanups fail and leave additional snapshots.

Local analyzers receive protected snapshot paths, selected checked source bytes, and managed inert configuration. Zedbee does not run package-manager lifecycle scripts, project commands, remediation, or executable project analyzer configuration.

## Local analyzer service

CLI scans and fixes normally share a private service for the current installation and Node runtime. It starts lazily, uses owner-restricted local sockets or Windows named pipes, and authenticates peers before accepting bounded source-bearing requests. Installed production contents are freshly checked when acquiring the service. No repository configuration can select a service endpoint, executable, worker module or ownership capability. This is local IPC, not a network upload or an operating-system sandbox; processes retain the invoking user's permissions.

Each analysis session freshly acquires its selected source bytes and clears source/project state on release. Engine modules with supported cleanup can remain loaded; compiler-backed React checks require worker retirement to release the upstream private source cache. Source, parsed programs and working-file formatting inputs are not a persistent service cache. Service discovery records contain protocol/content identity, a random instance and an authentication secret under owner-only permissions; they contain no source. Source-free coordination files can remain after shutdown, including an inert zero-byte completion file if a management client dies.

`scan --no-service` and `fix --no-service` close a local executor with the command. `service status` creates no state; `service stop` drains sessions and waits for native cleanup. The service also stops after five idle minutes. Snapshot deletion waits for execution cleanup, including an independent native cleanup proof after lost IPC. If cleanup cannot be proved, snapshots remain and the scan is incomplete. Correct the reported cause before retrying or removing them.

## Working-file fixes

Managed fix analysis uses the same isolated staged snapshots, then previews the
current working files that have supported candidates. Public managed fix plans
and results are source-free and contain no source text, replacements, hashes,
absolute repository paths, or replayable patches. Source-bearing candidate data
exists in the invoking process and bounded analyzer-session messages long enough to produce, validate and apply an approved plan. Formatting workers receive the complete current working source; that source is cleared with their session.

`zedbee fix` writes only validated working files. It does not stage or commit.
Exact lint and React edits are rejected when they overlap unstaged work;
selected Prettier formatting intentionally processes the complete current
working file, so it can reformat unstaged work. Review the working-tree diff
before staging anything.

## Secrets

Secrets are always redacted, including when source excerpts are enabled by repository policy or CLI override. Zedbee passes changed snapshot text directly to Secretlint's in-process API with its own fixed preset; it never loads `.secretlintrc` or executable project configuration. Secretlint results are immediately reduced to rule and location metadata. Raw secret text, match text, upstream messages, author data, and source lines never cross into Zedbee findings, events, text, JSON, source excerpts, or stable IDs. To distinguish a different secret replacing existing debt at the same rule and location, Zedbee computes a per-scan HMAC over the exact source range with a random key. The digest and key are ephemeral and are not rendered, cached, or persisted.

## Online vulnerability scanning

Zedbee's online-only OSV API client sends these metadata categories to `api.osv.dev`:

- package names;
- exact versions;
- the npm ecosystem identifier.

Repository source code and file hashes are not sent. Zedbee emits the service/category disclosure before scheduling online execution and persists it in Ink, text, and JSON results. File-scoped availability overrides are rejected.

There is no offline database mode. `checks.vulnerabilities.onUnavailable` controls an actual OSV outage or offline machine: `block` fails closed with an incomplete scan, while `warn` reports the incomplete check and permits the commit if no other policy blocks it. `zedbee init` asks for this choice whenever vulnerability scanning is available.

## Update notifications

Interactive CLI commands may request `https://registry.npmjs.org/zedbee/latest`
in a detached background process. This request retrieves Zedbee's public release
metadata; it does not send repository code, dependency lists, file hashes, or
the installed Zedbee version. npm receives ordinary connection metadata such
as the requesting IP address. Redirects are rejected, the response size and
request duration are bounded, and failures do not affect command results.

The updater stores only the check timestamp, release name/version, and optional
Node.js engine requirement in `zedbee/update.json` beneath `XDG_CACHE_HOME`
(when absolute), or `~/.cache` otherwise. This cache is separate from scan
observations. Checks are attempted at most daily during ordinary use, including
after a failed request; concurrent workers share a refresh lock. Cached notices
older than seven days are ignored. No update is automatically installed.

Set `ZEDBEE_NO_UPDATE_CHECK=1` or `NO_UPDATE_NOTIFIER=1` to prevent both requests
and notices. CI, redirected output, JSON, SARIF, and help/version-only invocations
do not start an update check. Update information is informational terminal output
and is not included in scan findings, temporary reports, or structured exports.

## Scan cache

When enabled, the content-addressed cache stores only schema-validated normalized observations and integrity metadata from analyzers whose complete inputs are confined to the captured snapshots. TypeScript, lint, and dead-code observations are deliberately not cached because installed dependency declarations, resolution state, and missing dependency lookups are not part of the snapshot fingerprint. New or unknown checks remain uncached until their inputs are audited. Installed engine identities come from the package metadata shipped with the active installation; missing identity metadata disables caching for that check. The cache must never store source, detected secret values, raw analyzer output, absolute snapshot paths, or online response bodies. Corrupt, ineligible, or incompatible entries are treated as misses.

## Report source visibility

Interactive Ink shows ordinary source excerpts from the selected immutable target snapshot by default: the staged index in index mode or committed `HEAD` in base mode. Redirected text, JSON, and SARIF source excerpts are default off. This means ordinary selected source may be visible to the human or agent that invokes an interactive scan; use `--no-source` to suppress it. Use `--include-source` to opt text, JSON, or SARIF in, or set repository policy to `always`; an explicit CLI choice overrides repository policy for that scan. SARIF follows the same source-excerpt policy and never exposes secret finding content.

Automatic scans always write their complete JSON report to protected operating-system temporary storage, including passes with zero findings. Forced `--format ink` writes one only when its finding preview overflows. Zedbee requests owner-only POSIX permissions (directory mode `0700`, file mode `0600`) where supported and relies on user-specific OS temporary-storage protections on other platforms. `reporting.temporaryReportMaxAge` defaults to `"24h"`. Temporary reports become eligible for cleanup at the configured age and are removed during a subsequent Zedbee maintenance run. The operating system may remove them sooner. These handoffs are not archives. Use explicit JSON or SARIF output/redirection for a durable export.

Interactive source excerpts and disk persistence deliberately use separate source-excerpt policy decisions. By default, an automatic temporary report omits ordinary source, while Ink may show excerpts with the `interactive` setting; `always` or `--include-source` permits persistence, while `never` or `--no-source` prevents it. Existing source options and CLI overrides apply to automatic reports. Secret content is always redacted under every choice.

Report cleanup and write warnings are non-blocking maintenance diagnostics. Zedbee prints a report path only after a complete file exists. If writing fails, it restores every finding to terminal output; if cleanup fails, it warns and discloses only a safely validated managed path when one is available.

## Agent and CI output

Explicit `--format text`, `--format json`, and `--format sarif` are complete surfaces with no terminal finding cap and no automatic report file. JSON and SARIF are stable machine surfaces; SARIF is emitted as a complete SARIF 2.1.0 report for enterprise ingestion. Both structured formats use repository-relative paths, deterministic ordering, stable finding IDs, explicit attribution evidence, and the same online disclosures as the interactive experience. ANSI decoration and animation are never included.
