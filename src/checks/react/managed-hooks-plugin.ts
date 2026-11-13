import { createHash } from "node:crypto";
import { readFileSync, lstatSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import type { ESLint } from "eslint";
import {
  managedHooksProvenanceSha256,
  managedHooksRevision,
} from "./managed-hooks-identity.js";

const require = createRequire(import.meta.url);
const root = new URL(
  "../../../dist/vendor/react-hooks/7.1.1/",
  import.meta.url,
);
const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function readRegular(url: URL): Buffer {
  const stat = lstatSync(url);
  if (!stat.isFile() || stat.isSymbolicLink())
    throw new Error("Invalid managed Hooks artifact");
  return readFileSync(url);
}

/** Verify exact build artifacts once, before loading executable code. */
export function verifyManagedHooksAssets(
  directory: URL,
  expectedProvenance: string,
): void {
  const bytes = readRegular(new URL("provenance.json", directory));
  if (hash(bytes) !== expectedProvenance)
    throw new Error("Managed Hooks provenance integrity mismatch");
  const manifest = JSON.parse(bytes.toString("utf8")) as {
    version: string;
    revision: string;
    files: Record<string, string>;
  };
  if (
    manifest.version !== "7.1.1" ||
    manifest.revision !== managedHooksRevision
  )
    throw new Error("Managed Hooks version mismatch");
  for (const file of [
    "index.cjs",
    "development.cjs",
    "production.cjs",
    "LICENSE",
  ]) {
    if (hash(readRegular(new URL(file, directory))) !== manifest.files[file])
      throw new Error("Managed Hooks artifact integrity mismatch");
  }
}

let cached: ESLint.Plugin | undefined;
export function managedHooksPlugin(): ESLint.Plugin {
  if (cached !== undefined) return cached;
  verifyManagedHooksAssets(root, managedHooksProvenanceSha256);
  const plugin = require(
    fileURLToPath(new URL("index.cjs", root)),
  ) as ESLint.Plugin;
  if (plugin.rules?.["set-state-in-effect"] === undefined)
    throw new Error("Invalid managed Hooks plugin");
  cached = plugin;
  return plugin;
}
