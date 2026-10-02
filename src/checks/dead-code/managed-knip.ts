// Anchor to this package in both source tests and compiled installations. Knip
// lives outside node_modules so its Zod dependency uses our private runtime
// without making npm replace an application's compatible Zod installation.
export const managedKnipEntry = new URL(
  "../../../dist/vendor/knip/dist/index.js",
  import.meta.url,
).href;
