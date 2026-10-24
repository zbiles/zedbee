# Swarm

Swarm brings Zedbee's JavaScript and TypeScript checks to coding agents. Set up
repository policy, inspect a complete scan report, repair authorized findings,
and verify the updated proposal while preserving unrelated work.

## Workflows

- **setup** locates the CLI, guides approved installation when missing, and reviews
  repository policy and optional Git hooks.
- **scan** checks the intended staged or committed proposal and explains every
  actionable finding and incomplete check.
- **fix** previews and applies authorized repairs, runs relevant tests, and verifies
  the updated target.
- **doctor** diagnoses installation, policy, dependencies and incomplete analysis.

In Claude Code, use `/swarm:setup`, `/swarm:scan`, `/swarm:fix`, or
`/swarm:doctor`. In Codex, select the corresponding skill from the installed
**Swarm** plugin or ask it to use Swarm for the task. Workflows can also be selected
when relevant to the task; they never grant additional write or execution rights.

This package is prepared for the official OpenAI and Anthropic directories.
A package in this repository does not establish a public directory listing;
publication requires approval in each directory. See the main repository's
[plugin distribution guide](https://github.com/zbiles/zedbee/blob/main/docs/plugin-distribution.md)
for package validation and submission details.

## Requirements and setup

Use a local coding environment with Git and Node.js ^22.17.0 or >=24.2.0, plus
the project's package manager. The agent runs Zedbee through the local CLI.
When the project has no installation, setup can download the pinned official
GitHub release, verify its SHA-256 and add it as a development dependency with
existing authorization. The helper only downloads; the agent reviews installation
and configuration changes. No analyzer, dependency or Git hook is installed merely
by opening a skill.

The published CLI release is identified in `references/cli-release.json`. Plugin
workflow versions and CLI release versions are independent. Existing project
installations are used as-is; unsupported options must be checked against that
CLI's help. Generated GitHub workflow support is available only in CLI versions
that expose `init --workflow`.

## Data and permissions

Source analysis runs locally. A normal scan reads staged content; `scan --base`
reads committed HEAD. Neither scans later working-tree edits. Managed fixes write
working files, never stage or commit, and whole-file formatting includes unstaged
work. Incomplete checks remain disclosed even when repository policy allows them.

The plugin itself does not send usage events or upload source or reports. The CLI
has optional usage telemetry **enabled by default** and honors existing preferences,
`ZEDBEE_TELEMETRY_DISABLED=1` and `DO_NOT_TRACK=1`. It sends command metadata to
`https://telemetry.zedbee.dev/v1/events` (Cloudflare forwarding to PostHog), excluding
source, paths, reports, hashes, secrets and dependency names. Disable it before
first use with an environment opt-out, or use `zedbee telemetry disable`.

Enabled vulnerability checks send dependency names, exact versions and ecosystems
to `api.osv.dev`. Interactive CLI commands can check npm for updates. Missing-CLI
setup downloads from the official GitHub release and installation retrieves
required packages from the configured package registry. The invoking agent's
provider and permissions determine how it handles repository content. Read the
[CLI privacy policy](https://github.com/zbiles/zedbee/blob/main/docs/privacy.md)
before sharing reports or enabling execution of project formatting code.

## License and support

Swarm uses the PolyForm Small Business License 1.0.0 in `LICENSE`. Commercial use
outside its permissions requires separate terms; see
[licensing](https://github.com/zbiles/zedbee/blob/main/docs/commercial-licensing.md).
Report problems at [GitHub issues](https://github.com/zbiles/zedbee/issues).
