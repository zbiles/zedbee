import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertOfficialManagedBinaryEntry } from "./managed-binary-source-policy.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadataOnly = process.argv.includes("--metadata-only");
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const selectedEngine = argument("--engine");
const selectedPlatform = argument("--platform");
const selectedArch = argument("--arch");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const fail = (message) => {
  throw new Error(`Managed binary verification failed: ${message}`);
};

function contained(rootPath, candidate) {
  const path = relative(rootPath, candidate);
  return path !== ".." && !path.startsWith("../") && !path.startsWith("..\\");
}

const centralPath = resolve(root, "packages/managed-binary/manifest.json");
const central = JSON.parse(await readFile(centralPath, "utf8"));
if (central.schemaVersion !== 1 || !Array.isArray(central.entries)) {
  fail("invalid central manifest");
}
if (central.entries.length !== 10) fail("expected ten platform entries");

const entries = central.entries.filter(
  (entry) =>
    (selectedEngine === undefined || entry.engine === selectedEngine) &&
    (selectedPlatform === undefined || entry.platform === selectedPlatform) &&
    (selectedArch === undefined || entry.arch === selectedArch),
);
if (entries.length === 0) fail("no manifest entries matched the selection");

const identities = new Set();
for (const entry of entries) {
  try {
    assertOfficialManagedBinaryEntry(entry);
  } catch {
    fail("managed source does not match the reviewed upstream release");
  }
  const identity = `${entry.engine}:${entry.platform}:${entry.arch}`;
  if (identities.has(identity)) fail(`duplicate ${identity}`);
  identities.add(identity);
  for (const field of ["assetSha256", "checksumSha256", "executableSha256"]) {
    if (!/^[a-f0-9]{64}$/.test(entry[field]))
      fail(`invalid ${field} for ${identity}`);
  }
  const packageDirectory = resolve(
    root,
    "packages",
    entry.packageName.replace("@zedbee/", ""),
  );
  const packageJson = JSON.parse(
    await readFile(resolve(packageDirectory, "package.json"), "utf8"),
  );
  const embedded = JSON.parse(
    await readFile(resolve(packageDirectory, "manifest.json"), "utf8"),
  );
  if (
    packageJson.name !== entry.packageName ||
    packageJson.os?.length !== 1 ||
    packageJson.os[0] !== entry.platform ||
    packageJson.cpu?.length !== 1 ||
    packageJson.cpu[0] !== entry.arch ||
    embedded.engine !== entry.engine ||
    embedded.version !== entry.version ||
    embedded.executablePath !== entry.executablePath ||
    embedded.executableSha256 !== entry.executableSha256
  ) {
    fail(`metadata mismatch for ${identity}`);
  }
  if (metadataOnly) continue;

  const canonicalPackage = await realpath(packageDirectory);
  const executable = await realpath(
    resolve(packageDirectory, entry.executablePath),
  );
  if (!contained(canonicalPackage, executable))
    fail(`escaped executable for ${identity}`);
  const executableBytes = await readFile(executable);
  if (sha256(executableBytes) !== entry.executableSha256) {
    fail(`executable checksum mismatch for ${identity}`);
  }
  for (const path of [entry.licensePath, entry.noticePath]) {
    const resolvedPath = await realpath(resolve(packageDirectory, path));
    if (!contained(canonicalPackage, resolvedPath))
      fail(`escaped notice for ${identity}`);
    await readFile(resolvedPath);
  }
  if (entry.configPath !== undefined) {
    const config = await realpath(resolve(packageDirectory, entry.configPath));
    if (!contained(canonicalPackage, config))
      fail(`escaped config for ${identity}`);
    if (sha256(await readFile(config)) !== entry.configSha256) {
      fail(`config checksum mismatch for ${identity}`);
    }
  }
}

console.log(
  metadataOnly
    ? "Managed binary metadata verified."
    : "Managed binary packages verified.",
);
