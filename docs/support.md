# Support Matrix

This document distinguishes implemented coverage from unsupported or deferred behavior. `zedbee checks --format json` is the machine-readable view of the current repository's configured checks and applicability.

## Runtime and project support

| Area              | Supported                                                    | Notes                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | Node.js 22.13.0 and newer                                    | CI verifies current Node 22 and 24 releases.                                                                                                             |
| Operating systems | Linux, macOS, and Windows                                    | CI runs the core suite on hosted runners for all three systems. Native npm dependencies must provide an artifact for the user's platform.                |
| Source            | `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts` | Zedbee targets JavaScript and TypeScript initially.                                                                                                      |
| Workspaces        | npm, pnpm, Yarn, and Bun JavaScript workspaces               | Discovery uses staged manifests and workspace declarations without running lifecycle scripts.                                                            |
| React             | React, React DOM, Ink, Next.js, and Remix correctness        | DOM accessibility runs only for React DOM, Next.js, and Remix—not Ink. React correctness calibrates each snapshot/workspace from staged dependency data. |
| Git input         | Exact staged index against committed `HEAD`                  | Intent-to-add entries are excluded. LFS pointers, submodules, and relevant binary text/source inputs report every affected path as incomplete.           |

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

React correctness can also use these supported staged lockfiles to refine a
workspace's direct staged `react` declaration. It uses only an unambiguous,
compatible record associated with that workspace; monorepo sibling records do
not qualify. Missing, unsupported, unreadable, or ambiguous lockfile data falls
back silently to the staged manifest version and then Zedbee's managed React
19.2 baseline. Users do not need to change a lockfile for React calibration.

## Project-analysis resolution boundary

Managed Knip analysis does not permit an imported package beneath `node_modules` to be supplied by the staged snapshot or by an ancestor directory. This prevents repository-controlled package code from entering analyzer module resolution. A repository that commits such a package receives an incomplete `deadCode` result; remove the committed package and restore dependencies through the package manager and lockfile. Ordinary ignored, locally installed dependencies remain supported.

React calibration likewise does not use plugin `detect` mode and never loads
project `node_modules`; it parses staged package manifests and supported
lockfiles instead, so it does not execute project React code.

When enabled, vulnerability analysis sends package name, exact version, and the npm ecosystem identifier to `api.osv.dev`. It is online only. Configure `checks.vulnerabilities.onUnavailable` as `block` or `warn`; `zedbee init` presents that choice and its disclosure.

## Secret scanning inputs

Secretlint scans non-deleted changed files from both the committed baseline and exact staged snapshot. Regular UTF-8 text files up to 1 MiB are supported. Binary files containing NUL bytes are skipped. Invalid UTF-8, oversized files, missing required snapshot content, and symbolic links make the secret check incomplete with the affected repository-relative path and remediation. Git history is not scanned.

Secret findings and overlapping source excerpts are always redacted. Zedbee never loads project Secretlint configuration.

## Reports and automation

Ink is the interactive human interface. Stable text, versioned JSON, and SARIF 2.1.0 are suitable for redirection, agents, and CI. Every explicit structured export is a complete report: it includes every finding and incomplete-scan notification, has no finding cap, and creates no automatic report file.

```bash
npx zedbee scan --format text > zedbee-report.txt
npx zedbee scan --format json > zedbee-report.json
npx zedbee scan --format sarif > zedbee.sarif
```

SARIF remains non-interactive and retains the normal scan exit status: exit code 0 allows the commit, 1 indicates completed blocking findings, and 2 indicates incomplete required analysis. An OSV outage configured as `warn` remains visible as incomplete but does not by itself block. Terminal presentation and explicit structured exports have separate contracts, so terminal finding limits never abbreviate an explicitly requested JSON or SARIF export.

## Not currently supported

- Semgrep-compatible taint, interfile, reachability, framework-pack, or live-registry analysis;
- Git-history secret scanning;
- an offline OSV database;
- legacy binary `bun.lockb` vulnerability parsing;
- repository path ignore/suppression rules for known Git LFS pointers or other unsupported staged inputs;
- automatic fixing or mutation of the Git index.
