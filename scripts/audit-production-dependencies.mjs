import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { commandInvocation } from "./command-invocation.mjs";
import { findProductionDependencies } from "./production-license-inventory.mjs";

export function productionAuditInputs(manifest, lockfile) {
  const auditManifest = structuredClone(manifest);
  const auditLockfile = structuredClone(lockfile);
  const vendors = manifest.vendoredDependencies ?? {};
  for (const root of [auditManifest, auditLockfile.packages[""]]) {
    root.dependencies = { ...root.dependencies, ...vendors };
    for (const name of Object.keys(vendors))
      delete root.devDependencies?.[name];
  }
  // npm audits lockfile classification, not the published file inventory.
  // Mark shipped build-time tools and their runtime closure as production in
  // an isolated audit copy; test-only dependencies remain excluded.
  for (const { packagePath } of findProductionDependencies(auditLockfile)) {
    delete auditLockfile.packages[packagePath].dev;
    delete auditLockfile.packages[packagePath].devOptional;
  }
  return { manifest: auditManifest, lockfile: auditLockfile };
}

function main() {
  const root = process.cwd();
  const inputs = productionAuditInputs(
    JSON.parse(readFileSync(join(root, "package.json"), "utf8")),
    JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8")),
  );
  const scratch = mkdtempSync(join(tmpdir(), "zedbee-production-audit-"));
  try {
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify(inputs.manifest),
    );
    writeFileSync(
      join(scratch, "package-lock.json"),
      JSON.stringify(inputs.lockfile),
    );
    const invocation = commandInvocation("npm", [
      "audit",
      "--omit=dev",
      "--ignore-scripts",
      "--audit-level=high",
      ...process.argv.slice(2),
    ]);
    const result = spawnSync(invocation.executable, invocation.args, {
      cwd: scratch,
      stdio: "inherit",
      env: { ...process.env, npm_config_cache: join(scratch, "npm-cache") },
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
)
  main();
