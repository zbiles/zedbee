# Privacy and Data Handling

## Local snapshot processing

Zedbee materializes two temporary representations: committed `HEAD` and the exact staged Git index. It does not scan later unstaged working-tree edits. Snapshot paths are validated under a Zedbee-owned temporary directory, staged links may not escape it, and cleanup runs before the command returns. Cleanup failure is itself an incomplete scan.

Local analyzers receive only protected snapshot paths and managed inert configuration. Zedbee does not run package-manager lifecycle scripts, project commands, remediation, or executable project analyzer configuration.

## Secrets

Gitleaks runs with redacted JSON output. Raw secret text, match text, entropy material, author data, source lines, and upstream fingerprints never enter Zedbee findings, events, text, JSON, or stable IDs. To distinguish a different secret replacing existing debt at the same rule and location, Zedbee computes a per-scan HMAC over the exact source range with a random key. The digest and key are ephemeral and are not rendered or persisted.

## Online vulnerability scanning

Online OSV-Scanner execution can send these metadata categories to `api.osv.dev` and `api.deps.dev`:

- package names;
- versions;
- ecosystems;
- supported file hashes.

It does not send repository source code. Zedbee emits the service/category disclosure before scheduling online execution and persists it in Ink, text, and JSON results. File-scoped network overrides are rejected.

For strict offline operation, configure `checks.vulnerabilities.network` as `offline` and set `ZEDBEE_OSV_DATABASE` to a verified pre-populated OSV cache. Offline execution uses both OSV's network-disabling and local-vulnerability flags. CI traces the real Linux process and fails if it opens an IPv4 or IPv6 socket.

## Cache

When enabled, the content-addressed cache stores only schema-validated normalized observations and integrity metadata. It must never store source, detected secret values, raw analyzer output, absolute snapshot paths, or online response bodies. Corrupt or incompatible entries are treated as misses.

## Agent and CI output

`--format json` is the stable machine surface. It uses repository-relative paths, deterministic ordering, stable finding IDs, explicit attribution evidence, and the same online disclosures as the interactive experience. ANSI decoration and animation are never included.
