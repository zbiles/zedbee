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

## Static JSX accessibility checks

`reactAccessibility` applies static JSX accessibility checks; it cannot certify
an accessible application. Test keyboard behavior, focus management, contrast,
and assistive technology against the rendered interface as well.

Teach the managed jsx-a11y engine about a design system with inert settings:

```json
{
  "schemaVersion": 1,
  "checks": {
    "reactAccessibility": {
      "settings": {
        "components": { "Photo": "img", "Button": "button" },
        "attributes": { "for": ["htmlFor", "for"] },
        "polymorphicPropName": "as",
        "polymorphicAllowList": ["Box"]
      }
    }
  }
}
```

Here `<Photo src="logo.png" />` receives the image's missing-alt check, while
`<Photo src="logo.png" alt="Logo" />` passes that check. `<Box as="img" />`
also receives image semantics. `attributes` maps a DOM attribute to an array of
JSX property names supported by jsx-a11y; the example permits `for` as well as
`htmlFor` for label association. A polymorphic allow list limits `as` handling to
named components; omitting it applies the configured property wherever the
plugin supports polymorphism. Dynamic rendered element names may be unknown to
static analysis.

These four fields are optional and default to no custom mappings. Use ordered
`overrides` to scope settings to workspace or file globs. Later settings replace
the corresponding field: a later `components` map replaces the earlier map,
while unrelated fields are retained. Configure mappings to match what components
actually render; Zedbee does not inspect their implementation to verify the map.
Mappings do not execute project code or load project plugins. The managed
focusable-separator correction also applies when the element uses a mapped
custom component.
