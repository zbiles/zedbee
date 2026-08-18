# Support Matrix

This document distinguishes implemented coverage from unsupported or deferred behavior. `zedbee checks --format json` is the machine-readable view of the current repository's configured checks and applicability.

## Runtime and project support

| Area              | Supported                                                    | Notes                                                                                                                                          |
| ----------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime           | Node.js 22.13.0 and newer                                    | CI verifies current Node 22 and 24 releases.                                                                                                   |
| Operating systems | Linux, macOS, and Windows                                    | CI runs the core suite on hosted runners for all three systems. Native npm dependencies must provide an artifact for the user's platform.      |
| Source            | `.js`, `.jsx`, `.mjs`, `.cjs`, `.ts`, `.tsx`, `.mts`, `.cts` | Zedbee targets JavaScript and TypeScript initially.                                                                                            |
| Workspaces        | npm, pnpm, Yarn, and Bun JavaScript workspaces               | Discovery uses staged manifests and workspace declarations without running lifecycle scripts.                                                  |
| React             | React, React DOM, Ink, Next.js, and Remix correctness        | DOM accessibility runs only for React DOM, Next.js, and Remix—not Ink.                                                                         |
| Git input         | Exact staged index against committed `HEAD`                  | Intent-to-add entries are excluded. LFS pointers, submodules, and relevant binary text/source inputs report every affected path as incomplete. |

## Dependency vulnerability inventories

| Package manager | Supported lockfile    | Status                                                                     |
| --------------- | --------------------- | -------------------------------------------------------------------------- |
| npm             | `package-lock.json`   | Supported lockfile versions are parsed locally.                            |
| npm             | `npm-shrinkwrap.json` | Supported lockfile versions are parsed locally.                            |
| pnpm            | `pnpm-lock.yaml`      | Parsed locally with bounded YAML input.                                    |
| Yarn Classic    | `yarn.lock`           | Parsed locally through the pinned `@yarnpkg/lockfile` package.             |
| Bun             | `bun.lock`            | The text lockfile is parsed locally.                                       |
| Bun legacy      | `bun.lockb`           | The binary format is not supported. Generate and stage `bun.lock` instead. |

Text lockfiles are limited to 8 MiB and are rejected before an oversized body is loaded into memory. Parsed structure, nesting, strings, dependency records, and OSV query counts have additional fixed safety limits.

When enabled, vulnerability analysis sends package name, exact version, and the npm ecosystem identifier to `api.osv.dev`. It is online only. Configure `checks.vulnerabilities.onUnavailable` as `block` or `warn`; `zedbee init` presents that choice and its disclosure.

## Secret scanning inputs

Secretlint scans non-deleted changed files from both the committed baseline and exact staged snapshot. Regular UTF-8 text files up to 1 MiB are supported. Binary files containing NUL bytes are skipped. Invalid UTF-8, oversized files, missing required snapshot content, and symbolic links make the secret check incomplete with the affected repository-relative path and remediation. Git history is not scanned.

Secret findings and overlapping source excerpts are always redacted. Zedbee never loads project Secretlint configuration.

## Reports and automation

Ink is the interactive human interface. Stable text and versioned JSON are suitable for redirection, agents, and CI. All three surfaces include every finding; there is no finding cap and no automatic report file.

```bash
npx zedbee scan --format text > zedbee-report.txt
npx zedbee scan --format json > zedbee-report.json
```

Exit code 0 allows the commit, 1 indicates completed blocking findings, and 2 indicates incomplete required analysis. An OSV outage configured as `warn` remains visible as incomplete but does not by itself block.

## Not currently supported

- Semgrep-compatible taint, interfile, reachability, framework-pack, or live-registry analysis;
- Git-history secret scanning;
- an offline OSV database;
- legacy binary `bun.lockb` vulnerability parsing;
- repository path ignore/suppression rules for known Git LFS pointers or other unsupported staged inputs;
- automatic fixing or mutation of the Git index.
