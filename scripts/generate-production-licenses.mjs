import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildProductionLicenseArtifacts } from "./check-production-licenses.mjs";

export async function generateProductionLicenseArtifacts(root) {
  const artifacts = await buildProductionLicenseArtifacts(root);
  if (artifacts.denied.length > 0) return artifacts;

  const inventoryPath = join(root, "licenses", "production-inventory.json");
  await mkdir(dirname(inventoryPath), { recursive: true });
  await writeFile(inventoryPath, artifacts.inventoryText);
  await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), artifacts.notices);
  return artifacts;
}

function reportDenials(denied) {
  process.stderr.write("Production license generation failed:\n");
  for (const { packageMetadata, reason } of denied) {
    process.stderr.write(
      `- ${packageMetadata.name ?? "unknown"}@${packageMetadata.version ?? "unknown"}: ${reason}\n` +
        `  path: ${packageMetadata.dependencyPath.join(" > ")}\n`,
    );
  }
}

async function main() {
  const { inventory, denied } = await generateProductionLicenseArtifacts(
    process.cwd(),
  );
  if (denied.length > 0) {
    reportDenials(denied);
    process.exitCode = 1;
    return;
  }
  process.stdout.write(
    `Generated production license artifacts (${inventory.packages.length} packages).\n`,
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  });
}
