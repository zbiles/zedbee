# Managed React Hooks correction

Swarm loads a private copy of eslint-plugin-react-hooks 7.1.1 with a correction to its effect state-update analysis. The upstream package remains an exact production dependency for provenance and original metadata. The copied compiler's external Babel, Hermes, and Zod validation dependencies are also exact direct dependencies of Swarm, so the private copy works with nested package layouts. The corrected copy retains upstream rule IDs, options, profiles, and MIT copyright/license. Native project ESLint continues loading its own plugin.

`analysis.js` is the readable replacement for the validation region in both pinned upstream bundles. `inputs.json` records the exact npm integrity and SHA-256 hashes of the upstream bundles, replacement boundaries, license, revision, and immutable upstream reference. No runtime rewriting or installation hooks are used.

After an intentional patch change, run `npm run hooks:generate`, review the generated `assets/react-hooks/7.1.1` files and generated identity, and run `npm run hooks:check`. A normal build checks these files and copies the allowlisted artifacts to `dist/vendor/react-hooks/7.1.1`. Both NODE_ENV variants are shipped. Any upstream version or input change requires explicit re-pinning and review; generation refuses fuzzy or duplicate replacement boundaries.

The loader validates artifact integrity once per process and the observation-cache identity includes the patch/provenance digest. Missing or corrupt assets fail analysis rather than falling back to the original checker.

Upstream reference: https://github.com/react/react/commit/d083ec1da1e5252abd3ddfdde6dfbc09701a2c51

Remove this correction only after an exact stable upstream version passes the entire effect-timing fixture corpus, existing React checks, scan/cache integration, and installed-package tests. Retain regression tests and change engine identity on removal. A canary fixing only post-await warnings is insufficient while immediate updates remain hidden by nested wrappers.
