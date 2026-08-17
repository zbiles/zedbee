# Security Policy

## Supported versions

Zedbee is not yet publicly released. Security fixes are made on the active v1 development line. The owner must publish a version-support table and private disclosure address before the first public release. That owner review is not a separate automated package-metadata gate; public release is currently blocked by the automated canonical repository, homepage, bugs URL, Git-remote, platform-artifact, cross-platform CI, and provenance checks.

## Reporting a vulnerability

Do not include credentials, proprietary source code, or other live secrets in a public issue. Until a private disclosure channel is published, contact the project owner directly through an already established private channel and include only the smallest synthetic reproduction needed to explain the issue.

A useful report identifies the affected Zedbee version or commit, platform, security boundary, expected behavior, observed behavior, and a synthetic proof of concept. Reports about a third-party analyzer should also name its package and pinned version.

## Security boundaries

Zedbee treats repository content and analyzer output as untrusted. It scans isolated Git-index snapshots, uses inert managed configuration, rejects executable project analyzer configuration, invokes library APIs where available, runs the remaining managed subprocesses without a shell, and removes temporary reports and snapshots after every outcome.

The following are security bugs and should be reported:

- reading or executing unstaged or out-of-snapshot repository content;
- exposing a detected secret, source line, absolute temporary path, or raw analyzer report;
- running an online check without its disclosure and configured network policy;
- loading project Secretlint, ESLint, Prettier, or other executable analyzer configuration;
- executing package-manager lifecycle scripts, project commands, or project analyzer configuration;
- following a staged symlink outside the protected snapshot;
- silently passing when a required check cannot complete.

Zedbee does not claim that static analysis finds every vulnerability. Its structural rules are narrower than Semgrep and do not provide general interfile dataflow, taint, reachability, or framework-pack analysis.
