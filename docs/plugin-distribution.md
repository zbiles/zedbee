# Swarm plugin distribution

Swarm's agent plugin is prepared for the official OpenAI and Anthropic plugin
directories. It provides setup, scan, fix and doctor workflows. A built package or
GitHub branch is not a marketplace listing. Users can search for and install
**Swarm** in those directories only after the publisher submits it, each platform
completes review, and the approved version is published.

## Source and packaging

The self-contained plugin is in `plugins/swarm/`. `plugin.json` is the maintained
metadata source. The Claude manifest and plugin license are generated mirrors;
`plugin:check` rejects drift. The standalone `zedbee agent` command uses the same
scan workflow and retains the standalone skill name `zedbee`. Plugin versions are
independent of the CLI release pinned for missing-installation setup.

```sh
npm run plugin:generate
npm run plugin:check
npm run plugin:pack -- /absolute/path/to/existing/output-folder
```

The pack command produces `swarm-<plugin-version>.zip`, including only reviewed
plugin files. It preserves an existing output archive. It does not include project
sources, credentials, local configuration, node_modules or a custom marketplace.
The ZIP is the OpenAI upload artifact. Anthropic reads `plugins/swarm/` directly
from the GitHub repository and selected branch or tag.

Run a current official Claude validator against the plugin folder:

```sh
claude plugin validate --strict plugins/swarm
```

Directory listing fields require Claude Code 2.1.281 or newer; older validators
warn about those supported fields. Validate the built ZIP after extraction too.
The public directories run additional metadata, policy and safety checks.

## Official OpenAI submission

Open [OpenAI's plugin submission portal](https://platform.openai.com/plugins).
Use the verified publisher identity that owns Zedbee, upload the ZIP, and resolve
all automated metadata and skill findings before submitting for review. The
package declares local execution and an onboarding setup skill. It contains no
MCP server and follows the skills-only submission route. Once approved, publish
from the portal and verify the public **Swarm** listing and installation.

Authentication and publisher verification are account steps; the package cannot
grant them. Follow [OpenAI's submission guide](https://developers.openai.com/plugins/deploy/submission)
and [desktop execution requirements](https://developers.openai.com/plugins/deploy/desktop-only).
Do not claim a listing or approval merely because local validation succeeded.

## Official Anthropic submission

Open [Anthropic's developer portal](https://claude.ai/directory/manage) and choose
**Plugin bundle**. Set repository `zbiles/zedbee` and plugin path `plugins/swarm`.
Choose the branch or tag containing the validated plugin. The submitting account
needs the required paid plan/role and a connected GitHub account with push access.

Validate the selected commit, review the generated listing, answer the data
handling questions accurately, and complete the required acknowledgements using
the authorized publisher's account. Submit for review. Publish the approved
version and verify the public listing and Claude Code installation. The official
`claude-plugins-official` marketplace and Anthropic's directory have different
listing routes; submission here follows the currently documented directory route.
See [Anthropic's submission guide](https://claude.com/docs/plugins/submit).

## Privacy, installation, and updates

The plugin README discloses local source analysis, the invoking agent's access,
CLI telemetry (enabled by default, with opt-outs), OSV dependency metadata,
GitHub release downloads and package-registry installation. Preserve normal CLI
telemetry preferences. Review the linked privacy policy and license before
submitting data-handling or legal acknowledgements.

Missing-CLI setup downloads and verifies the pinned official release. Installation
saves the stable HTTPS release URL, preserving reproducible dependency metadata;
it must never save a temporary file path. npm lockfile integrity must match the
verified artifact before execution. Update the release URL, version and checksum
together after verifying a new published artifact. Do not replace an existing
release asset or assume an unpublished npm version is available.

For a new plugin version, update the canonical manifest, regenerate its mirrors,
run checks and build a new ZIP. OpenAI metadata/skill updates require a new upload.
Anthropic follows its selected GitHub branch/tag and review/publish settings.
