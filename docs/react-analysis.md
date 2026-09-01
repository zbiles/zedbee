# React analysis policy

Zedbee runs React correctness checks only in workspaces that inspection identifies
as React, React DOM, Ink, Next.js, or Remix. DOM accessibility rules run only for
React DOM, Next.js, and Remix; JSX syntax alone does not imply a browser renderer.
This prevents DOM-specific advice from being applied to Ink terminal components.

Project ESLint, Babel, parser, and plugin configuration is never loaded. Zedbee
uses its pinned React, Hooks, and JSX accessibility plugins with report-only flat
configuration.

## React version calibration

For each workspace and each isolated snapshot, React correctness independently
calibrates the managed React plugin from that snapshot's data. It first reads the
direct `react` declaration from that selected snapshot's `package.json`. If its exact
version or supported semver range can be resolved, Zedbee then prefers one
unambiguous matching direct record from a supported lockfile in the same
snapshot: `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`,
`yarn.lock`, or `bun.lock`. An exact workspace importer wins; otherwise a
lockfile-wide record may be used only when that lockfile owns the workspace.
This prevents a sibling workspace's lockfile record from calibrating the wrong
package in a monorepo.

If a supporting lockfile cannot be parsed, no matching record is unambiguous,
or the record belongs to another workspace, Zedbee silently uses the resolvable
selected manifest version instead. If the direct React declaration is absent,
unsupported, or cannot be resolved, Zedbee silently falls back to its managed
React 19.2 baseline. This makes calibration deterministic and gives
version-sensitive rules more appropriate input without requiring developers to
edit lockfiles for Zedbee.

Zedbee deliberately does not use eslint-plugin-react's `detect` mode: it would
probe the scanned project's installed package tree. React calibration parses
only manifests and lockfiles from the selected snapshot and never loads project
node_modules or executes project React code. Baseline and target snapshots are
calibrated independently, so a React upgrade is analyzed with each side's own
declared dependency state. Rules of Hooks, missing list keys, and DOM accessibility
rules do not depend on the React version setting.
