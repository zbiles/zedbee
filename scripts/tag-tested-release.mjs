import { exactVersion } from "../plugins/swarm/scripts/download-cli.mjs";
import {
  assertPredecessorCoverage,
  previousUpgradeVersions,
} from "./smoke-consumer-upgrade.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  assertCleanReleaseCheckout,
  releaseArtifactIdentity,
} from "./prepare-release-artifact.mjs";

export function verifyUpgradeEvidence(evidence, identity) {
  for (const key of ["commit", "version", "sha256"])
    assert.equal(
      evidence?.[key],
      identity[key],
      `Release evidence has a different ${key}.`,
    );
  assert.ok(exactVersion(identity.version), "Invalid release version.");
  if (evidence.runId !== undefined) {
    assert.equal(typeof evidence.runId, "string");
    assert.match(evidence.runId, /^[0-9]+$/u);
  }
  assert.deepEqual(
    evidence.upgradedFrom,
    previousUpgradeVersions(identity.version),
    "Release evidence must record successful upgrades from every configured prior version.",
  );
}

function main() {
  const root = process.cwd();
  const [directory = "release-artifacts", flag] = process.argv.slice(2);
  assertCleanReleaseCheckout(root);
  const { version } = JSON.parse(
    readFileSync(join(root, "package.json"), "utf8"),
  );
  assert.ok(exactVersion(version), "Invalid release version.");
  assertPredecessorCoverage(root, version);
  const archive = resolve(directory, `zedbee-${version}.tgz`);
  const verification = resolve(directory, "upgrade-verification.json");
  for (const file of [archive, verification]) {
    assert.ok(lstatSync(file).isFile(), "Expected a regular release file.");
  }
  const identity = releaseArtifactIdentity(root, archive);
  const evidence = JSON.parse(readFileSync(verification, "utf8"));
  verifyUpgradeEvidence(evidence, identity);
  const tag = `v${identity.version}`;
  const message =
    `Zedbee ${identity.version} archive SHA-256 ${identity.sha256}` +
    (evidence.runId === undefined ? "" : ` (run ${evidence.runId})`);
  if (flag === "--verify-tag") {
    assert.equal(process.env.GITHUB_REF_NAME, tag);
    const git = (args) =>
      execFileSync("git", args, { encoding: "utf8" }).trim();
    assert.equal(git(["rev-list", "-n", "1", tag]), identity.commit);
    assert.equal(
      git(["for-each-ref", "--format=%(contents:subject)", `refs/tags/${tag}`]),
      message,
    );
    process.stdout.write(`Verified tested artifact for ${tag}.\n`);
    return;
  }
  if (flag !== undefined) throw new Error("Unknown release tag option.");
  execFileSync(
    "git",
    ["tag", "--annotate", "--message", message, tag, identity.commit],
    { stdio: "inherit" },
  );
  process.stdout.write(`Created ${tag} for the tested archive.\n`);
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
