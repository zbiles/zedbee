# Install and configure Swarm

Inspect repository instructions, Git status, package manifests, lockfiles, hooks,
CI and existing policy. Identify the repository root and the project that should
own the Zedbee development dependency. Preserve existing work and partial staging.
Record the exact pre-install manifest and lockfile contents and whether those
files already existed; Git HEAD is not a backup of the user's current work.

Require Node ^22.17.0 or >=24.2.0, Git and the project's package manager. Do not
replace these tools silently. Locate an existing installed CLI in the selected
workspace before downloading anything, and consistently use that local executable.
Read its package.json for the installed version; there is no assumed `--version`.
Require a corresponding dependency declaration and consistent lockfile/resolved
version before treating it as an existing usable installation. A reverted manifest
can leave an undeclared node_modules copy behind; offer the normal verified
installation to reconcile that state instead of executing the orphaned copy.

## Install a missing CLI

Offer installation if it is not already authorized, then run the packaged helper:

```sh
node <plugin-root>/scripts/download-cli.mjs
```

Resolve `<plugin-root>` from this reference's location: the parent of `references/`.
Check the helper's process status before reading its JSON. It downloads the exact
official npm registry release in `cli-release.json`, checks the pinned SHA-256,
and returns `version`, `package` (`zedbee@<exact-version>`), canonical registry
`url`, npm-compatible SHA-512 `integrity`, private `tarball`, and `directory`.
Keep the verified artifact until installation and integrity checks are complete.

Install the returned exact **package specifier**, not a GitHub URL, redirect URL,
downloaded file path, or unpinned tag. Use the existing package manager:

```sh
npm install --save-dev --save-exact --ignore-scripts -- zedbee@<exact-version>
pnpm add --save-dev --save-exact --ignore-scripts zedbee@<exact-version>
yarn add --dev --exact --ignore-scripts zedbee@<exact-version>
```

These are alternatives, not commands to run in sequence. Use the Yarn command
only with Yarn Classic; for other managers, use their supported equivalent and
verify their lockfile integrity before execution. In a pnpm workspace, add
`--workspace-root` only when the selected dependency owner is the root; otherwise
run in or target the intended member. Preserve package-manager choice, workspace
ownership and lockfile conventions. Do not upgrade unrelated dependencies, enable
lifecycle scripts, or bypass repository dependency restrictions.

Confirm the installed Zedbee version and manifest dependency match the exact
requested version. Inspect the matching lockfile package entry and compare its
tarball integrity with the helper's verified `integrity` before executing the CLI:
npm's package-lock entry, pnpm's `packages` resolution for `zedbee@<version>`, or
Yarn Classic's matching `integrity` entry. Do not confuse an importer's version
with the package resolution integrity. No dependency or lock entry may point at
`release-assets.githubusercontent.com`, a signed query URL or temporary file.
If integrity is missing or differs, stop and report it. Never invent a checksum,
silently change managers, or execute the unverified installation.

Remove only the helper-created private `directory` after verification; it must
not be needed for subsequent installs. Never derive a cleanup path from a scan
finding or other untrusted report.

## Configure hooks and CI

Read the installed CLI's `init --help`. Preview configuration without changing it:

```sh
zedbee init --hook none --format json
```

Read the complete proposal. Reuse existing policy and hook managers; explain the
specific configuration, dependency, hook, and CI changes before applying. Offer
pre-commit, GitHub CI, or both according to the request and repository. Recommend
both for a GitHub repository, preserving an existing workflow where appropriate.
Hook setup covers pre-commit and pre-merge-commit; it does not add a pre-push hook.
Use the installed CLI's supported hook choices and `--workflow github` when
available. The current pinned npm release supports workflow generation; existing
older installations may not. Explain unavailable options rather than invoking
unsupported flags or claiming an integration exists.

`init --yes` applies the selected proposal only when those writes are authorized.
Interactive init offers the same review. Disclose CLI telemetry, enabled by
default, before first CLI execution; honor any requested opt-out beforehand and
preserve existing preferences. The plugin README documents the service and data.
Do not enable project formatting trust merely to finish setup.

Verify the resulting hook's activation and workflow invocation, not just file
creation. A tracked hook may need activation in another checkout. CI must use the
committed branch comparison rather than scan an empty index. Workflow generation
does not itself make the check a required branch-protection rule. If a scan is
requested, follow [the scan workflow](scan.md): policy and source must be in the
selected index or commit before that scan observes them. Never stage or commit
as an implicit setup step.

## Preserve work on failures

Never run `git checkout --`, `git restore`, `git reset`, or broad cleanup to undo
installation. They can discard changes that existed before setup. Undo only this
operation's edits when the saved baseline and current files prove that safe;
preserve intervening changes and stop with a precise diff if uncertain. Do not
remove a pre-existing lockfile or node_modules directory. Report any install state
that remains and the package manager command needed to reconcile it.

Finish by reporting the installed version, selected checks, hook activation, CI
configuration, changed paths, verification performed, and any pending work. A
preview or partial setup is not completion.
