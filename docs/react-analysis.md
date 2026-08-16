# React analysis policy

Zedbee runs React correctness checks only in workspaces that inspection identifies
as React, React DOM, Ink, Next.js, or Remix. DOM accessibility rules run only for
React DOM, Next.js, and Remix; JSX syntax alone does not imply a browser renderer.
This prevents DOM-specific advice from being applied to Ink terminal components.

Project ESLint, Babel, parser, and plugin configuration is never loaded. Zedbee
uses its pinned React, Hooks, and JSX accessibility plugins with report-only flat
configuration.

## React version calibration

Zedbee currently fixes the managed plugin setting to React 19.2 instead of using
the plugin's `detect` mode. Detection would probe the scanned project's installed
package tree, while a fixed value keeps analysis deterministic and prevents
project package code or mutable working-tree metadata from entering the analyzer
boundary.

Negative impact: version-sensitive rules, especially deprecated-API rules, may
not perfectly match projects on older or newer React releases. Rules of Hooks,
missing list keys, and DOM accessibility rules do not depend on that version
setting. A future release may derive the declared React version from the inert
staged package manifest once that value is part of the inspection contract.
