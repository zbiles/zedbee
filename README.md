# Zedbee

A trust gate for AI-assisted development.

AI coding tools can write code faster than a team can review it. Zedbee checks JavaScript and TypeScript changes before they become commits, or in CI before a merge. It looks for security issues, exposed secrets, code quality problems, and more. Your team decides which findings block the work.

Zedbee reports problems your changes introduce or make worse. Existing issues don't overwhelm every review, and developers don't have to fix the whole repository just to ship one change.

Use it alongside code review and tests. Zedbee checks human-written and AI-generated code the same way. A passing scan is not a guarantee that code is safe.

## Try it on your next commit

Requires Git and Node.js versions matching `^22.17.0 || >=24.2.0`. Run these commands from your project's root:

```bash
npm install --save-dev zedbee@next
npx zedbee init
```

The public beta is available under npm's `next` tag. Setup recommends checks for your project and previews a `.zedbeerc.jsonc` configuration file and pre-commit hook. It explains network use and asks before writing anything.

Stage the configuration and the files you intend to commit, including the package manifest and lockfile changes from installation. Then run:

```bash
npx zedbee scan
```

Zedbee scans the version you staged, even if you have edited the file again since staging it. Nothing staged means nothing to scan. A newly created configuration must also be staged before a scan uses it.

With the hook installed, Zedbee runs when you commit. You can also run it manually at any time. Hooks are local and can be bypassed, so use CI with a required check if your team needs to enforce the gate before merging.

## What it checks

- Exposed secrets, known dependency vulnerabilities, and unsafe code patterns.
- TypeScript errors, lint, and formatting.
- Complex code, duplicated code, unused code and packages, and dependency structure.
- React correctness and React DOM accessibility.

Zedbee brings established tools together, including TypeScript, ESLint, Prettier, Secretlint, and Knip. You don't need to wire each one into a hook. Some checks inspect the whole project to understand a change, but Zedbee reports findings tied to the changes under review.

Run `npx zedbee checks` to see which checks apply to your project and what they can and cannot detect. The [check guide](docs/checks.md) lists every check, its engine, and its limits.

## Set your team's rules

Choose the `fast`, `recommended`, or `thorough` profile during setup. Use `.zedbeerc.jsonc` to set checks to block, warn, or stay off, and to adjust supported rules and thresholds. Commit that file so the team shares the policy.

You can give particular files different settings or exclude files and directories from named checks. Every exclusion needs a reason. See the [configuration reference](docs/cli-reference.md#configuration) for examples.

Zedbee uses its own settings. It does not load your existing ESLint, Prettier, or other native analyzer configuration, so results may differ from those tools. Review the [supported customization options](docs/checks.md#managed-customization) when adopting it.

Scans never change source files. The separate `zedbee fix` command rescans current staged code and previews supported fixes before asking for approval. It writes working files and never stages or commits. Formatting can affect an entire file, including unstaged edits. Read the [fix guide](docs/managed-fixes.md) before using it.

## Check a branch in CI

An ordinary scan checks staged changes, not the commits in a pull request. To compare your branch with `main`, install the project's dependencies and run:

```bash
git fetch --no-tags origin main
npx zedbee scan --base origin/main --format sarif > zedbee.sarif
```

The checkout needs enough Git history to find where the branches split. A shallow checkout may need more history. This mode checks committed code and reads configuration from the checked-out commit.

A scan returns `0` for no blocking findings, `1` for findings that block under your policy, or `2` when Zedbee cannot complete a required check. Treat an incomplete result as unknown, not a pass.

For coding agents and other tools, JSON is also available through `--format json`. Both JSON and SARIF exports contain the complete report. See [CI setup details](docs/cli-reference.md#committed-branch-scans-in-ci) and the [reporting guide](docs/reporting.md).

## Before you adopt it

Source analysis runs locally. Dependency vulnerability checks send package names and versions to OSV, not source code. Interactive commands can also check npm for updates. The [privacy guide](docs/privacy.md) explains network use, temporary files, and report contents.

The security checks cover specific unsafe patterns. They cannot identify every vulnerability or determine whether an AI's implementation matches your intent. See [security coverage](docs/structural-security-coverage.md) and [supported projects and limitations](docs/support.md).

The command line is the supported interface. The [programmatic API](docs/cli-reference.md#experimental-programmatic-api) is experimental.

## Documentation and help

Start with `npx zedbee doctor` if setup or a scan isn't working.

- [CLI reference and troubleshooting](docs/cli-reference.md)
- [Website](https://zedbee.dev)
- [Bug reports](https://github.com/zbiles/zedbee/issues)
- [Report a security vulnerability privately](SECURITY.md)

## License

Zedbee is source-available under the [PolyForm Small Business License 1.0.0](LICENSE).

Zedbee is free to use and modify for businesses with fewer than 100 employees and contractors combined, and prior-year revenue below US$1 million in 2019 dollars, adjusted for inflation. These limits include related organizations as defined by the license. Commercial licenses are available for organizations outside those limits.

See the [licensing guide](docs/commercial-licensing.md) or email [licensing@zedbee.dev](mailto:licensing@zedbee.dev).
