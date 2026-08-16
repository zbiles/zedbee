import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import parseSpdxExpression from "spdx-expression-parse";
import { buildProductionInventory } from "./production-license-inventory.mjs";

const policyPath = fileURLToPath(
  new URL("../licenses/allowed-production-licenses.json", import.meta.url),
);
const policy = JSON.parse(await readFile(policyPath, "utf8"));
const allowedLicenses = new Set(policy.allowedLicenses);
const obligationLicenses = new Set(["MPL-2.0", "CC-BY-4.0"]);

function evaluateParsedNode(node) {
  if (node.conjunction === "or") {
    const left = evaluateParsedNode(node.left);
    const right = evaluateParsedNode(node.right);
    if (!left.allowed) return right;
    if (!right.allowed) return left;
    return left.obligations.length <= right.obligations.length ? left : right;
  }

  if (node.conjunction === "and") {
    const left = evaluateParsedNode(node.left);
    if (!left.allowed) return left;
    const right = evaluateParsedNode(node.right);
    if (!right.allowed) return right;
    return {
      allowed: true,
      selected: `(${left.selected} AND ${right.selected})`,
      obligations: [
        ...new Set([...left.obligations, ...right.obligations]),
      ].sort(compareText),
    };
  }

  const expression = `${node.license}${node.plus ? "+" : ""}${
    node.exception ? ` WITH ${node.exception}` : ""
  }`;
  if (!node.plus && !node.exception && allowedLicenses.has(node.license)) {
    return {
      allowed: true,
      selected: node.license,
      obligations: obligationLicenses.has(node.license) ? [node.license] : [],
    };
  }
  return {
    allowed: false,
    reason: `license is not allowlisted: ${expression}`,
  };
}

export function evaluateLicense(license) {
  if (typeof license !== "string" || license.trim() === "") {
    return { allowed: false, reason: "missing license metadata" };
  }

  const expression = license.trim();
  if (/^(?:UNLICENSED|SEE LICENSE IN(?:\s|$))/i.test(expression)) {
    return {
      allowed: false,
      reason: `license metadata is not redistributable: ${expression}`,
    };
  }

  let parsed;
  try {
    parsed = parseSpdxExpression(expression);
  } catch {
    return {
      allowed: false,
      reason: `unparsable SPDX expression: ${expression}`,
    };
  }
  const result = evaluateParsedNode(parsed);
  return result.allowed ? { allowed: true, selected: result.selected } : result;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertContained(root, target, label) {
  const fromRoot = relative(root, target);
  if (
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    isAbsolute(fromRoot)
  ) {
    throw new Error(`unsafe reviewed license text path: ${label}`);
  }
}

async function readContainedText(root, relativePath) {
  if (
    typeof relativePath !== "string" ||
    relativePath.includes("\\") ||
    relativePath.startsWith("/") ||
    relativePath.split("/").includes("..")
  ) {
    throw new Error(
      `unsafe reviewed license text path: ${String(relativePath)}`,
    );
  }
  const lexicalPath = resolve(root, ...relativePath.split("/"));
  const resolvedPath = await realpath(lexicalPath);
  assertContained(root, resolvedPath, relativePath);
  return (await readFile(resolvedPath, "utf8"))
    .replaceAll("\r\n", "\n")
    .replace(/[\t ]+$/gmu, "");
}

async function reviewedOverrides(root) {
  const metadataPath = join(root, "licenses", "reviewed-overrides.json");
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(
      `unable to read reviewed license overrides: ${error.message}`,
      {
        cause: error,
      },
    );
  }
  if (metadata?.schemaVersion !== 1 || !Array.isArray(metadata.overrides)) {
    throw new Error("invalid reviewed license override metadata");
  }
  const seen = new Set();
  return metadata.overrides.map((candidate) => {
    if (
      typeof candidate?.name !== "string" ||
      typeof candidate.version !== "string" ||
      typeof candidate.license !== "string" ||
      typeof candidate.sourceUrl !== "string" ||
      !candidate.sourceUrl.startsWith("https://") ||
      typeof candidate.textFile !== "string" ||
      !candidate.textFile.startsWith("licenses/overrides/")
    ) {
      throw new Error("invalid reviewed license override metadata");
    }
    const key = `${candidate.name}\u0000${candidate.version}`;
    if (seen.has(key)) throw new Error("duplicate reviewed license override");
    seen.add(key);
    return Object.freeze({
      name: candidate.name,
      version: candidate.version,
      license: candidate.license,
      sourceUrl: candidate.sourceUrl,
      textFile: candidate.textFile,
    });
  });
}

async function reviewedObligations(root) {
  const metadataPath = join(root, "licenses", "reviewed-obligations.json");
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`unable to read reviewed obligations: ${error.message}`, {
      cause: error,
    });
  }
  if (metadata?.schemaVersion !== 1 || !Array.isArray(metadata.obligations)) {
    throw new Error("invalid reviewed obligation metadata");
  }
  const seen = new Set();
  return metadata.obligations.map((candidate) => {
    for (const field of [
      "name",
      "version",
      "license",
      "sourceUrl",
      "attribution",
      "changes",
      "notice",
    ]) {
      if (typeof candidate?.[field] !== "string" || candidate[field] === "") {
        throw new Error("invalid reviewed obligation metadata");
      }
    }
    if (!candidate.sourceUrl.startsWith("https://")) {
      throw new Error("invalid reviewed obligation metadata");
    }
    const key = `${candidate.name}\u0000${candidate.version}\u0000${candidate.license}`;
    if (seen.has(key)) throw new Error("duplicate reviewed obligation");
    seen.add(key);
    return Object.freeze({ ...candidate });
  });
}

async function noticesForInventory(root, inventory) {
  const overrides = await reviewedOverrides(root);
  const obligations = await reviewedObligations(root);
  const sections = [];
  const usedObligationKeys = new Set();
  for (const packageMetadata of inventory.packages) {
    const legalTexts = [];
    for (const legalFile of packageMetadata.legalFiles) {
      legalTexts.push({
        label: legalFile,
        text: await readContainedText(root, legalFile),
      });
    }
    let provenance;
    if (legalTexts.length === 0) {
      provenance = overrides.find(
        (override) =>
          override.name === packageMetadata.name &&
          override.version === packageMetadata.version &&
          override.license === packageMetadata.license,
      );
      if (provenance === undefined) {
        throw new Error(
          `missing license or notice text for ${packageMetadata.name ?? "unknown"}@${
            packageMetadata.version ?? "unknown"
          }`,
        );
      }
      legalTexts.push({
        label: provenance.textFile,
        text: await readContainedText(root, provenance.textFile),
      });
    }

    const licenseDecision =
      typeof packageMetadata.license === "string"
        ? evaluateParsedNode(parseSpdxExpression(packageMetadata.license))
        : { allowed: false, obligations: [] };
    const selectedObligations = [];
    if (licenseDecision.allowed) {
      for (const license of licenseDecision.obligations) {
        const obligation = obligations.find(
          (candidate) =>
            candidate.name === packageMetadata.name &&
            candidate.version === packageMetadata.version &&
            candidate.license === license,
        );
        if (obligation === undefined) {
          throw new Error(
            `missing reviewed obligation metadata for ${packageMetadata.name}@${packageMetadata.version} (${license})`,
          );
        }
        usedObligationKeys.add(
          `${obligation.name}\u0000${obligation.version}\u0000${obligation.license}`,
        );
        selectedObligations.push(obligation);
      }
    }

    const header = [
      `## ${packageMetadata.name ?? "unknown"}@${packageMetadata.version ?? "unknown"}`,
      "",
      `License: ${packageMetadata.license ?? "unknown"}`,
      ...selectedObligations.flatMap((obligation) => [
        `Source: ${obligation.sourceUrl}`,
        `Attribution: ${obligation.attribution}`,
        `Changes: ${obligation.changes}`,
        `Compliance notice: ${obligation.notice}`,
      ]),
      ...(provenance === undefined
        ? []
        : [
            `Reviewed override source: ${provenance.sourceUrl}`,
            `Reviewed override text: ${provenance.textFile}`,
          ]),
    ];
    const texts = legalTexts.flatMap(({ label, text }) => [
      "",
      `### ${label}`,
      "",
      text.replace(/\n+$/u, ""),
    ]);
    sections.push([...header, ...texts].join("\n"));
  }
  const staleObligations = obligations.filter(
    (obligation) =>
      !usedObligationKeys.has(
        `${obligation.name}\u0000${obligation.version}\u0000${obligation.license}`,
      ),
  );
  if (staleObligations.length > 0) {
    throw new Error(
      `stale reviewed obligation metadata: ${staleObligations
        .map(({ name, version, license }) => `${name}@${version} (${license})`)
        .sort(compareText)
        .join(", ")}`,
    );
  }
  sections.sort(compareText);
  return [
    "# Third-Party Notices",
    "",
    "This file is generated deterministically from production dependency license and notice texts.",
    "",
    ...sections.flatMap((section, index) =>
      index === 0 ? [section] : ["---", "", section],
    ),
    "",
  ].join("\n");
}

export async function generateThirdPartyNotices(root) {
  const canonicalRoot = await realpath(root);
  const inventory = await buildProductionInventory(canonicalRoot);
  return appendManagedBinaryNotices(
    await noticesForInventory(canonicalRoot, inventory),
    await managedBinaryNoticeSections(canonicalRoot),
  );
}

async function managedBinaryNoticeSections(root) {
  let manifest;
  try {
    manifest = JSON.parse(
      await readFile(
        join(root, "packages", "managed-binary", "manifest.json"),
        "utf8",
      ),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const engines = new Map();
  for (const entry of manifest.entries ?? []) {
    engines.set(entry.engine, entry.version);
  }
  return [...engines]
    .map(([engine, version]) => {
      if (engine === "gitleaks") {
        return [
          `## Gitleaks@${version} (managed executable)`,
          "",
          "License: MIT",
          "Repository: https://github.com/gitleaks/gitleaks",
          "Distribution: complete MIT terms are included in every @zedbee/gitleaks-* platform package.",
        ].join("\n");
      }
      if (engine === "osv-scanner") {
        return [
          `## OSV-Scanner@${version} (managed executable)`,
          "",
          "License: Apache-2.0",
          "Repository: https://github.com/google/osv-scanner",
          "Distribution: complete Apache-2.0 terms and attribution are included in every @zedbee/osv-scanner-* platform package.",
        ].join("\n");
      }
      throw new Error(`unknown managed binary notice engine: ${engine}`);
    })
    .sort(compareText);
}

function appendManagedBinaryNotices(notices, sections) {
  if (sections.length === 0) return notices;
  return `${notices.replace(/\n+$/u, "")}\n\n---\n\n${sections.join("\n\n---\n\n")}\n`;
}

export async function buildProductionLicenseArtifacts(root) {
  const canonicalRoot = await realpath(root);
  const inventory = await buildProductionInventory(canonicalRoot);
  const notices = appendManagedBinaryNotices(
    await noticesForInventory(canonicalRoot, inventory),
    await managedBinaryNoticeSections(canonicalRoot),
  );
  const denied = inventory.packages.flatMap((packageMetadata) => {
    const result = evaluateLicense(packageMetadata.license ?? undefined);
    return result.allowed ? [] : [{ packageMetadata, reason: result.reason }];
  });

  return {
    inventory,
    inventoryText: `${JSON.stringify(inventory, null, 2)}\n`,
    notices,
    denied,
  };
}

async function readReleaseArtifact(path, label) {
  try {
    return await readFile(path);
  } catch (error) {
    throw new Error(`missing or unreadable release safety artifact: ${label}`, {
      cause: error,
    });
  }
}

export async function checkProductionLicenses(root) {
  const artifacts = await buildProductionLicenseArtifacts(root);
  if (artifacts.denied.length > 0) return artifacts;

  const inventoryPath = join(root, "licenses", "production-inventory.json");
  const noticesPath = join(root, "THIRD_PARTY_NOTICES.md");
  const [committedInventory, committedNotices] = await Promise.all([
    readReleaseArtifact(inventoryPath, "licenses/production-inventory.json"),
    readReleaseArtifact(noticesPath, "THIRD_PARTY_NOTICES.md"),
  ]);
  const stale = [
    ...(committedInventory.equals(Buffer.from(artifacts.inventoryText, "utf8"))
      ? []
      : ["licenses/production-inventory.json"]),
    ...(committedNotices.equals(Buffer.from(artifacts.notices, "utf8"))
      ? []
      : ["THIRD_PARTY_NOTICES.md"]),
  ];
  if (stale.length > 0) {
    throw new Error(
      `stale release safety artifacts: ${stale.join(", ")}; run npm run licenses:generate`,
    );
  }
  return artifacts;
}

async function main() {
  const root = process.cwd();
  const { inventory, denied } = await checkProductionLicenses(root);
  if (denied.length === 0) {
    process.stdout.write(
      `Production license check passed (${inventory.packages.length} packages).\n`,
    );
    return;
  }

  process.stderr.write("Production license check failed:\n");
  for (const denial of denied) {
    const { packageMetadata, reason } = denial;
    process.stderr.write(
      `- ${packageMetadata.name ?? "unknown"}@${packageMetadata.version ?? "unknown"}: ${reason}\n` +
        `  path: ${packageMetadata.dependencyPath.join(" > ")}\n`,
    );
  }
  process.exitCode = 1;
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
