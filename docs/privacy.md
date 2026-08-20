# Privacy and Data Handling

## Local snapshot processing

Zedbee materializes two temporary representations: committed `HEAD` and the exact staged Git index. It does not scan later unstaged working-tree edits. Source excerpts are read from that exact index snapshot, so an excerpt cannot be replaced by later working-tree content. An intent-to-add entry supplies no staged file content and is excluded as unstaged. Staged Git LFS pointers and submodule pointers cannot be inspected and make the scan incomplete. Binary assets remain allowed, but binary paths selected by enabled source, formatting, or vulnerability checks are incomplete rather than silently skipped. Every affected path is reported; a configurable ignore system is deferred beyond v1.

Snapshot paths are validated under a Zedbee-owned temporary directory, staged links may not escape it, and cleanup runs before the command returns. Cleanup failure is itself an incomplete scan and may disclose one validated Zedbee temporary directory so the invoking human or agent can inspect and remove exactly what remains. If Zedbee cannot safely validate the directory's identity, it reports no path and instead directs the operator to inspect the OS temporary directory for stale `zedbee-snapshot-*` directories. Correct permissions, locks, or filesystem problems before retrying: a persistent cause can make later cleanups fail and leave additional snapshots.

Local analyzers receive only protected snapshot paths and managed inert configuration. Zedbee does not run package-manager lifecycle scripts, project commands, remediation, or executable project analyzer configuration.

## Secrets

Secrets are always redacted, including when source excerpts are enabled by repository policy or CLI override. Zedbee passes changed snapshot text directly to Secretlint's in-process API with its own fixed preset; it never loads `.secretlintrc` or executable project configuration. Secretlint results are immediately reduced to rule and location metadata. Raw secret text, match text, upstream messages, author data, and source lines never cross into Zedbee findings, events, text, JSON, source excerpts, or stable IDs. To distinguish a different secret replacing existing debt at the same rule and location, Zedbee computes a per-scan HMAC over the exact source range with a random key. The digest and key are ephemeral and are not rendered, cached, or persisted.

## Online vulnerability scanning

Zedbee's online-only OSV API client sends these metadata categories to `api.osv.dev`:

- package names;
- exact versions;
- the npm ecosystem identifier.

Repository source code and file hashes are not sent. Zedbee emits the service/category disclosure before scheduling online execution and persists it in Ink, text, and JSON results. File-scoped availability overrides are rejected.

There is no offline database mode. `checks.vulnerabilities.onUnavailable` controls an actual OSV outage or offline machine: `block` fails closed with an incomplete scan, while `warn` reports the incomplete check and permits the commit if no other policy blocks it. `zedbee init` asks for this choice whenever vulnerability scanning is available.

## Cache

When enabled, the content-addressed cache stores only schema-validated normalized observations and integrity metadata. It must never store source, detected secret values, raw analyzer output, absolute snapshot paths, or online response bodies. Corrupt or incompatible entries are treated as misses.

## Report source visibility

Interactive Ink shows ordinary staged source excerpts by default. Redirected text, JSON, and SARIF source excerpts are default off. This means ordinary indexed source may be visible to the human or agent that invokes an interactive scan; use `--no-source` to suppress it. Use `--include-source` to opt text, JSON, or SARIF in, or set repository policy to `always`; an explicit CLI choice overrides repository policy for that scan. SARIF follows the same source-excerpt policy and never exposes secret finding content.

When automatically selected terminal output or forced `--format ink` exceeds `reporting.terminalFindingLimit`, Zedbee writes the complete JSON report to protected operating-system temporary storage before printing its path. Zedbee requests owner-only POSIX permissions (directory mode `0700`, file mode `0600`) where supported and relies on user-specific OS temporary-storage protections on other platforms. `reporting.temporaryReportRetention` defaults to 5 subsequent runs, but the operating system may delete temporary files early; the path is a short-lived handoff, not durable archival storage.

Interactive source excerpts and disk persistence deliberately use separate source-excerpt policy decisions. With the default `interactive` setting, Ink may show ordinary excerpts while an automatic temporary report omits them; `always` or `--include-source` permits persistence, while `never` or `--no-source` prevents it. Secret findings remain redacted under every choice.

Report cleanup and write warnings are non-blocking maintenance diagnostics. Zedbee prints a report path only after a complete file exists. If writing fails, it restores every finding to terminal output; if cleanup fails, it warns and discloses only a safely validated managed path when one is available.

## Agent and CI output

Explicit `--format text`, `--format json`, and `--format sarif` are complete surfaces with no terminal finding cap and no automatic report file. JSON and SARIF are stable machine surfaces; SARIF is emitted as a complete SARIF 2.1.0 report for enterprise ingestion. Both structured formats use repository-relative paths, deterministic ordering, stable finding IDs, explicit attribution evidence, and the same online disclosures as the interactive experience. ANSI decoration and animation are never included.
