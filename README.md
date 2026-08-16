# Zedbee

Zedbee is a diff-aware pre-commit scanner for JavaScript and TypeScript projects. It scans the exact Git index, attributes findings to staged changes, and leaves unrelated existing debt out of the current developer's way.

The managed suite covers formatting, lint, TypeScript correctness, cyclomatic complexity, original readability complexity, structural security, duplication, dependency architecture, dead code/package hygiene, React correctness, and React DOM accessibility. Analyzers use the exact Git-index snapshot, compare an isolated baseline where the check requires one, and pass observations through central staged-change attribution.

## Requirements

- Node.js 22.13.0 or newer
- Git

## Install

```bash
npm install --save-dev zedbee
```

Run a scan directly:

```bash
npx zedbee scan
```

Zedbee does not modify source files and does not provide automatic fixing in v1.

For guided setup, preview the detected project, recommended policy, network use, and exact hook/config edits:

```bash
npx zedbee init
```

Nothing is written until the interactive confirmation. Automation can apply the same proposal with `--yes`; use `--format json` for a deterministic machine-readable preview/result.

## Commands

| Command         | Purpose                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `zedbee init`   | Recommend checks and safely add `.zedbeerc.jsonc` plus a Husky, Lefthook, simple-git-hooks, or raw Git pre-commit integration              |
| `zedbee scan`   | Scan the exact staged snapshot and return pass, blocked, or incomplete                                                                     |
| `zedbee checks` | Explain every configured check, applicability, targets, engine/license, network use, and limitation without running analysis               |
| `zedbee doctor` | Diagnose Git, Node, configuration, snapshots, workspaces, hooks, managed engines/checksums, licenses, and OSV setup without running a scan |

`init` supports `--profile fast|recommended|thorough`, `--hook auto|husky|lefthook|simple-git-hooks|raw|none`, `--checks <comma-separated IDs>`, `--yes`, and text/JSON output. `scan`, `checks`, and `doctor` accept `--config <path>`.

## Exact staged content

Zedbee treats the Git index as the proposed commit. If you stage a file and edit it again without staging the later edit, Zedbee scans the staged version. It materializes isolated `HEAD` and index snapshots with Git plumbing and cleans them after every outcome.

An analyzer may inspect a whole file or project when correctness requires it. Zedbee separately attributes the result and reports only issues introduced or worsened by staged work.

## Configuration

The optional root configuration is `.zedbeerc.jsonc`. It is data, not executable project code.

```jsonc
{
  "$schema": "./node_modules/zedbee/schema/zedbee.schema.json",
  "schemaVersion": 1,
  "profile": "recommended",
  "checks": {
    "formatting": { "severity": "error", "when": "relevant" },
    "cyclomaticComplexity": { "max": 20, "blockWorsening": true },
    "readabilityComplexity": { "max": 15, "blockWorsening": true },
  },
  "failOnIncomplete": true,
}
```

Profiles are `fast`, `recommended`, and `thorough`. A check can use severity `off`, `warn`, or `error`, and timing `relevant` or `always`. The managed defaults are cyclomatic complexity 20 and readability complexity 15; both block a staged increase that remains above the configured limit.

The versioned editor schema ships at `node_modules/zedbee/schema/zedbee.schema.json`. `zedbee init` writes that local schema reference, so validation does not depend on a website being available.

## Managed analyzer boundary

Zedbee ships and pins Prettier 3.9.6, ESLint 9.39.5, typescript-eslint 8.67.0, TypeScript 6.0.3, eslint-plugin-react 7.37.5, eslint-plugin-react-hooks 7.1.1, eslint-plugin-jsx-a11y 6.10.2, ast-grep 0.45.1, jscpd 5.0.15, Dependency Cruiser 18.2.0, and Knip 6.32.2. It supplies its own inert analyzer configuration and never loads project ESLint, Prettier, Babel, parser, plugin, or executable analyzer configuration. TypeScript configuration is parsed as staged data, not executed; installed declaration packages may be resolved through the constrained project `node_modules` boundary. A workspace containing TypeScript source must provide a contained `tsconfig.json`; otherwise typed lint and type analysis fail closed. This is stricter than tools that silently invent compiler options, but avoids validating staged code under settings different from the project.

Project checks inspect a workspace as a whole, then compare the isolated `HEAD` and index snapshots so existing debt remains non-blocking. This roughly doubles analyzer work. Knip runs as a managed shell-free subprocess because it has no supported analysis API; all framework plugins are disabled so repository configs cannot execute. That safety choice is less framework-aware than a normal Knip setup, and dynamic imports, framework conventions, wildcard package exports, and TypeScript path aliases may need future managed profiles. jscpd also runs as a subprocess and receives an exact source-file list; exceptionally large workspaces can exceed the operating system argument limit and fail incomplete. Dependency Cruiser runs through its public API.

React correctness runs for React, React DOM, Ink, Next.js, and Remix. DOM accessibility runs only when inspection finds React DOM, Next.js, or Remix, so Ink terminal components do not receive browser-DOM advice. React rules use a fixed React 19.2 setting; version-sensitive deprecated-API advice may be less exact for older or newer projects.

Zedbee Readability Complexity is an original metric, not Sonar Cognitive Complexity, and teams migrating from Sonar must recalibrate thresholds. The built-in structural-security rules are deliberately narrower than Semgrep: they have no dataflow, taint, interfile analysis, reachability, framework packs, or live rule registry. See [the readability scoring contract](docs/readability-complexity.md), [React analysis policy](docs/react-analysis.md), and [structural-security coverage](docs/structural-security-coverage.md).

Use another repository-contained JSONC file when needed:

```bash
npx zedbee scan --config config/zedbee.jsonc
```

## Output

```text
--format auto   Ink in an interactive terminal, text when piped
--format ink    Live Ink progress and the compact Zedbee result
--format text   Stable human-readable output
--format json   Versioned structured output for CI and agents
```

Accessibility controls:

```bash
npx zedbee scan --no-color
npx zedbee scan --no-animations
NO_COLOR=1 npx zedbee scan
```

Status always includes labels or symbols in addition to color. Text and JSON output contain no terminal animation or logo control sequences.

For coding agents and CI, prefer `zedbee scan --format json`. JSON is versioned, deterministically ordered, ANSI-free, repository-relative, and includes stable finding IDs, attribution evidence, incomplete states, and network disclosures. Agents should treat exit code 2 as unknown/incomplete—not as a clean scan—and should never bypass the hook merely because a finding is not automatically fixable.

## Exit codes

| Code | Meaning                                                 |
| ---: | ------------------------------------------------------- |
|  `0` | Scan completed with no blocking findings                |
|  `1` | Scan completed and repository policy blocked the commit |
|  `2` | Zedbee or an enabled check could not complete           |

Interrupted scans clean temporary snapshots before returning the platform's conventional interruption status.

## Hooks

`zedbee init --hook auto` detects Husky, Lefthook, simple-git-hooks, or raw Git hooks. It preserves unrelated commands, shows exact before/after hashes and diffs, refuses symlink targets, writes atomically, and rolls back earlier writes if a later write fails. Linked worktrees resolve the real Git hook path instead of assuming `.git` is a directory.

Generated hooks run `npx --no-install zedbee scan`. This prevents an unexpected network download during a commit, but it means Zedbee must remain installed in the project. Run `zedbee init` again to preview an idempotent update; an existing Zedbee invocation is not duplicated.

## Cache and performance

Zedbee may cache content-addressed, normalized observations for deterministic local analyzers. Cache keys include the staged snapshots, policy, workspace/config inputs, engine identity, and runtime platform. Cache failures and corruption are misses and never reduce coverage. Source, raw analyzer output, Gitleaks observations, OSV results, secrets, and online response bodies are never cached. Cached and uncached reports are required to remain semantically identical.

## Current coverage

The managed suite currently includes:

1. Prettier formatting, ESLint and typescript-eslint lint, TypeScript diagnostics, both complexity metrics, original ast-grep security checks, React correctness, and React DOM accessibility.
2. jscpd duplication, Dependency Cruiser architecture validation, and Knip dead-code/package-hygiene analysis across npm, pnpm, Yarn, and Bun workspaces.
3. Exact staged snapshots, baseline comparison, changed-range and syntax-entity attribution, stable text/JSON output, and the approved live Ink progress display.
4. Checksum-verified Gitleaks secret scanning with irreversible redaction, plus OSV-Scanner vulnerability comparison in disclosed online or strict offline mode.

Optional Semgrep is not part of the v1 managed suite and is not silently approximated by the current structural rules. Managed binaries currently support Darwin and Linux on x64/arm64 and Windows on x64; other platforms report incomplete analysis. Online vulnerability scanning sends package names, versions, ecosystems, and supported file hashes to OSV/deps.dev, but never source code. Set `checks.vulnerabilities.network` to `offline` and provide `ZEDBEE_OSV_DATABASE` to use a pre-populated local database without network access.

See [the complete check matrix](docs/checks.md), [privacy and data handling](docs/privacy.md), and [security policy](SECURITY.md).

## Troubleshooting

- Run `npx zedbee doctor` first; JSON mode is useful when sharing sanitized diagnostics.
- Exit code 2 means a required result is incomplete. Resolve the diagnostic rather than treating it as a pass.
- TypeScript workspaces need a contained staged `tsconfig.json`; Zedbee does not invent compiler options.
- Offline vulnerability checks need a pre-populated database at `ZEDBEE_OSV_DATABASE`.
- Unsupported managed-binary platforms fail incomplete. The supported release matrix is Darwin/Linux x64 and arm64, plus Windows x64.
- If a hook cannot find Zedbee, restore the project-local dev dependency; generated hooks deliberately use `npx --no-install`.
- Very large jscpd source lists can exceed the operating system argument limit, and framework-heavy Knip projects may need future managed profiles. Both cases are reported rather than silently skipped.

## License

Zedbee is distributed under the [PolyForm Small Business License 1.0.0](https://polyformproject.org/licenses/small-business/1.0.0). The npm SPDX identifier is `PolyForm-Small-Business-1.0.0`. See [LICENSE](LICENSE) for the complete terms.

PolyForm applies to Zedbee's own code; bundled tools and npm dependencies retain their separate licenses, including Gitleaks under MIT and OSV-Scanner under Apache License 2.0. Uses outside PolyForm's permissions require separate terms from the licensor. See [commercial use and third-party licensing](docs/commercial-licensing.md). This documentation is not legal advice; commercial distribution should receive qualified legal review.
