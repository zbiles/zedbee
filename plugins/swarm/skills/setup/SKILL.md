---
name: setup
description: Set up Zedbee Swarm in the selected repository, including CLI installation when missing, reviewed check configuration, and optional Git hooks.
---

# Set up Swarm

Inspect repository instructions, Git status, package manifests and lockfiles.
Identify the repository root and the project folder that should own the Zedbee
development dependency. Preserve existing work and partial staging. Run commands
from their intended folder with literal paths. Require Node ^22.17.0 or >=24.2.0,
Git, and the project's package manager; do not replace those tools silently.

Locate the project's installed `zedbee` executable, including nested project
installations. Use that executable consistently. If it is missing and installation
is authorized, obtain the published CLI with the plugin's download helper:

```sh
node <plugin-root>/scripts/download-cli.mjs
```

Resolve `<plugin-root>` from this skill's location: two directories above its
`setup/` folder. The helper downloads the exact official release declared in
`references/cli-release.json`, checks its pinned SHA-256, and returns JSON with
`version`, canonical `url`, npm-compatible `integrity`, and `tarball`. Check its process status before parsing output. The
private temporary directory contains only that downloaded artifact; keep it
until installation finishes, then remove that exact directory. Do not pass a
report-provided path to cleanup commands.

Install the verified canonical HTTPS URL as a development dependency using the repository's
package manager and existing version policy. For npm, use
`npm install --save-dev --ignore-scripts -- <url>` with the returned URL as a
literal argument. Do not save the temporary tarball path as a dependency: it would
leave a broken machine-local `file:` reference after cleanup. For npm, confirm
the installed Zedbee lockfile entry's `integrity` matches the helper's verified
integrity before running that installation. If it differs, stop and report the
unverified installation; do not execute its CLI. For another package manager,
verify its installed release integrity against the same verified artifact before
execution (for example, pnpm's resolution integrity or Yarn Classic's integrity).
If that manager cannot expose comparable integrity for this installation, stop
before running the downloaded CLI and explain the outstanding verification; do
not change package managers or accept unchecked bytes as a shortcut.
Preserve package-manager choice, workspace ownership and lockfile
conventions; do not run broad dependency upgrades. Ask only if installation or its
target needs authorization not already provided. Installation changes the selected
manifest and lockfile; review those changes. Do not run third-party lifecycle
scripts merely to complete this setup.

Preview setup with the installed CLI:

```sh
zedbee init --hook none --format json
```

Read the entire proposal. Reuse existing policy and explain which settings would
change. Choose a profile, checks and hook integration according to the requested
setup. `init --yes` applies the exact selected proposal when those writes are
already authorized. Interactive `zedbee init` provides the same review and an
optional telemetry choice. Noninteractive setup preserves existing telemetry
preferences. See the plugin README privacy disclosure before first CLI use;
follow any requested opt-out without overriding it later.

A GitHub workflow is optional. Offer it when the installed CLI's `init --help`
includes `--workflow`; the currently pinned published release predates that flag.
Do not invoke unsupported options or claim a workflow was installed when absent.

Review the generated files and dependency changes. Setup does not stage or commit.
If a scan is requested, read [the scan workflow](../scan/SKILL.md): configuration
and source must be in the selected index or commit before a scan observes them.
Report the installed CLI version, selected settings and hooks, changed paths,
and any remaining setup step. Do not call preview-only setup completed.
