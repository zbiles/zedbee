import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { commandInvocation } from "./command-invocation.mjs";

import { smokeConsumerUpgrades } from "./smoke-consumer-upgrade.mjs";

const TEMPORARY_PREFIX = "zedbee-release-smoke-";
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;

function run(command, args, options) {
  const invocation = commandInvocation(command, args);
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
    maxBuffer: MAX_COMMAND_OUTPUT,
  });
  if (result.error !== undefined) throw result.error;
  const expectedStatuses = options.expectedStatuses ?? [0];
  if (!expectedStatuses.includes(result.status)) {
    const detail = (result.stderr || result.stdout || "No output").trim();
    throw new Error(`${options.label} failed.\n${detail}`);
  }
  return options.combinedOutput ? result.stderr + result.stdout : result.stdout;
}

export function assertReleaseBaseScanReport(report, expected) {
  const hasExpectedFinding =
    report !== null &&
    typeof report === "object" &&
    Array.isArray(report.checks) &&
    report.checks.some(
      (check) =>
        check?.checkId === "formatting" &&
        Array.isArray(check.findings) &&
        check.findings.some(
          (finding) => finding?.location?.file === "branch.ts",
        ),
    );
  if (
    report === null ||
    typeof report !== "object" ||
    report.mode !== "base" ||
    report.baseline !== expected.baseline ||
    report.target !== expected.target ||
    report.requestedBase !== expected.baseline ||
    report.changedFileCount !== 1 ||
    report.outcome !== "blocked" ||
    report.exitCode !== 1 ||
    !hasExpectedFinding
  ) {
    throw new Error(
      "Installed CLI did not block the committed base-mode smoke scan.",
    );
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} did not return valid JSON.`);
  }
}

export function releaseArtifactFilename(packOutput, manifest) {
  let parsed;
  try {
    parsed = JSON.parse(packOutput);
  } catch {
    throw new Error("npm did not describe a valid release artifact.");
  }
  const record =
    Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  const expected = `zedbee-${manifest.version}.tgz`;
  if (
    manifest.name !== "zedbee" ||
    typeof manifest.version !== "string" ||
    record?.name !== manifest.name ||
    record?.version !== manifest.version ||
    record?.filename !== expected ||
    basename(record.filename ?? "") !== record.filename
  ) {
    throw new Error(
      "npm did not produce the canonical Zedbee release artifact.",
    );
  }
  return record.filename;
}

function validateTemporaryRoot(path) {
  const canonicalTemp = realpathSync(tmpdir());
  const canonicalPath = realpathSync(path);
  if (
    dirname(canonicalPath) !== canonicalTemp ||
    !basename(canonicalPath).startsWith(TEMPORARY_PREFIX) ||
    !lstatSync(canonicalPath).isDirectory()
  ) {
    throw new Error("Refused to clean an invalid release-smoke directory.");
  }
  return canonicalPath;
}

function smokeReleaseArtifact(artifactPath, manifest) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), TEMPORARY_PREFIX));
  try {
    const fixture = join(temporaryRoot, "fixture");
    const cache = join(temporaryRoot, "npm-cache");
    mkdirSync(fixture);
    const environment = { ...process.env, npm_config_cache: cache };
    run("git", ["init", "--initial-branch=main"], {
      cwd: fixture,
      label: "Git initialization",
    });
    run("git", ["config", "user.email", "zedbee-release@example.invalid"], {
      cwd: fixture,
      label: "Git email configuration",
    });
    run("git", ["config", "user.name", "Zedbee Release Smoke Test"], {
      cwd: fixture,
      label: "Git name configuration",
    });
    writeFileSync(
      join(fixture, "package.json"),
      `${JSON.stringify(
        { name: "zedbee-release-smoke", version: "1.0.0", private: true },
        null,
        2,
      )}\n`,
    );
    writeFileSync(join(fixture, ".gitignore"), "node_modules/\n");
    writeFileSync(
      join(fixture, "tsconfig.json"),
      '{"compilerOptions":{"strict":true},"include":["**/*.ts"]}\n',
    );
    run(
      "npm",
      [
        "install",
        "--save-dev",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        artifactPath,
      ],
      {
        cwd: fixture,
        env: environment,
        label: "Exact tarball installation",
      },
    );
    const installedManifest = parseJson(
      readFileSync(
        join(fixture, "node_modules", "zedbee", "package.json"),
        "utf8",
      ),
      "Installed package manifest",
    );
    if (
      installedManifest.name !== manifest.name ||
      installedManifest.version !== manifest.version
    ) {
      throw new Error(
        "Installed package identity differs from the release artifact.",
      );
    }
    run("git", ["add", "--all"], {
      cwd: fixture,
      label: "Fixture staging",
    });
    run("git", ["commit", "--no-gpg-sign", "-m", "release fixture"], {
      cwd: fixture,
      label: "Fixture commit",
    });

    const cli = join(fixture, "node_modules", "zedbee", "dist", "cli.js");
    const cliCommand = (args, label) =>
      run(process.execPath, [cli, ...args], { cwd: fixture, label });
    const help = cliCommand(["--help"], "Installed CLI help");
    for (const command of ["init", "scan", "checks", "doctor"]) {
      if (!help.includes(command)) {
        throw new Error(`Installed CLI help is missing ${command}.`);
      }
    }

    const initialized = parseJson(
      cliCommand(
        [
          "init",
          "--profile",
          "fast",
          "--hook",
          "raw",
          "--yes",
          "--format",
          "json",
          "--no-color",
          "--no-animations",
        ],
        "Installed CLI initialization",
      ),
      "Installed CLI initialization",
    );
    if (initialized.applied !== true) {
      throw new Error(
        "Installed CLI did not apply its initialization proposal.",
      );
    }
    const hook = readFileSync(
      join(fixture, ".git", "hooks", "pre-commit"),
      "utf8",
    );
    if (
      !hook.includes(
        "node './node_modules/zedbee/dist/cli.js' scan --hook-invocation",
      ) ||
      !hook.includes("git rev-parse --show-toplevel")
    ) {
      throw new Error(
        "Installed CLI did not create the expected pre-commit hook.",
      );
    }

    const doctor = parseJson(
      cliCommand(["doctor", "--format", "json"], "Installed CLI doctor"),
      "Installed CLI doctor",
    );
    if (doctor.exitCode !== 0) {
      throw new Error(
        "Installed CLI doctor did not pass after initialization.",
      );
    }

    run("git", ["add", "--all"], {
      cwd: fixture,
      label: "Base-mode fixture staging",
    });
    run("git", ["commit", "--no-gpg-sign", "-m", "base-mode fixture policy"], {
      cwd: fixture,
      label: "Base-mode fixture commit",
    });
    const baseline = run("git", ["rev-parse", "HEAD"], {
      cwd: fixture,
      label: "Base-mode baseline resolution",
    }).trim();
    writeFileSync(
      join(fixture, "branch.ts"),
      "export const branch={value:1}\n",
    );
    run("git", ["add", "--", "branch.ts"], {
      cwd: fixture,
      label: "Base-mode finding staging",
    });
    run(
      "git",
      [
        "commit",
        "--no-gpg-sign",
        "--no-verify",
        "-m",
        "base-mode committed finding",
      ],
      { cwd: fixture, label: "Base-mode finding commit" },
    );
    const target = run("git", ["rev-parse", "HEAD"], {
      cwd: fixture,
      label: "Base-mode target resolution",
    }).trim();
    const baseReport = parseJson(
      run(
        process.execPath,
        [
          cli,
          "scan",
          "--base",
          baseline,
          "--format",
          "json",
          "--no-color",
          "--no-animations",
        ],
        {
          cwd: fixture,
          label: "Installed CLI committed base-mode scan",
          expectedStatuses: [1],
        },
      ),
      "Installed CLI committed base-mode scan",
    );
    assertReleaseBaseScanReport(baseReport, { baseline, target });

    writeFileSync(join(fixture, "value.ts"), "export const value = 1;\n");
    run("git", ["add", "--", "value.ts"], {
      cwd: fixture,
      label: "Scan fixture staging",
    });
    const report = parseJson(
      cliCommand(
        ["scan", "--format", "json", "--no-color", "--no-animations"],
        "Installed CLI scan",
      ),
      "Installed CLI scan",
    );
    if (report.outcome !== "pass" || report.exitCode !== 0) {
      throw new Error("Installed CLI did not pass its staged smoke scan.");
    }
  } finally {
    rmSync(validateTemporaryRoot(temporaryRoot), {
      recursive: true,
      force: false,
    });
  }
}

function releaseHead(root) {
  return run("git", ["rev-parse", "HEAD"], {
    cwd: root,
    label: "Release commit identity",
  }).trim();
}

export function releaseArtifactIdentity(root, archivePath) {
  const commit = releaseHead(root);
  const { version } = parseJson(
    readFileSync(join(root, "package.json"), "utf8"),
    "Release manifest",
  );
  const sha256 = createHash("sha256")
    .update(readFileSync(archivePath))
    .digest("hex");
  return { commit, version, sha256 };
}

export function assertCleanReleaseCheckout(root) {
  const status = run("git", ["status", "--porcelain"], {
    cwd: root,
    label: "Release checkout status",
  }).trim();
  if (status)
    throw new Error(
      "Commit the candidate before preparing or tagging the release.",
    );
}

export function prepareReleaseArtifact(
  cwd = process.cwd(),
  { smokeOnly = false } = {},
) {
  const root = realpathSync(cwd);
  const artifactDirectory = join(root, "release-artifacts");
  if (!smokeOnly) {
    assertCleanReleaseCheckout(root);
    if (
      existsSync(artifactDirectory) &&
      (!lstatSync(artifactDirectory).isDirectory() ||
        readdirSync(artifactDirectory).length !== 0)
    )
      throw new Error(
        "The release artifact directory already contains a candidate.",
      );
  }
  const manifest = parseJson(
    readFileSync(join(root, "package.json"), "utf8"),
    "Release manifest",
  );
  const startingCommit = smokeOnly ? undefined : releaseHead(root);
  const scratch = mkdtempSync(join(tmpdir(), TEMPORARY_PREFIX));
  try {
    smokeConsumerUpgrades({ root, version: manifest.version, scratch, run });
    run(
      process.execPath,
      [join(root, "scripts", "check-package-contents.mjs")],
      {
        cwd: root,
        label: "Release package contents",
      },
    );
    const output = run(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
      {
        cwd: root,
        env: { ...process.env, npm_config_cache: join(scratch, "npm-cache") },
        label: "Release artifact packing",
      },
    );
    const filename = releaseArtifactFilename(output, manifest);
    const archive = join(scratch, filename);
    if (!lstatSync(archive).isFile())
      throw new Error("Expected a regular npm archive.");
    smokeReleaseArtifact(archive, manifest);
    const installedSmoke = join(scratch, "installed");
    mkdirSync(installedSmoke);
    const upgradedFrom = smokeConsumerUpgrades({
      root,
      version: manifest.version,
      scratch: installedSmoke,
      archive,
      run,
    });
    if (smokeOnly) {
      process.stdout.write(
        `Smoke-tested ${filename} including the consumer upgrade.\n`,
      );
      return undefined;
    }

    assertCleanReleaseCheckout(root);
    const identity = releaseArtifactIdentity(root, archive);
    if (
      identity.commit !== startingCommit ||
      identity.version !== manifest.version
    )
      throw new Error("The release checkout changed during verification.");
    const promotion = mkdtempSync(join(root, "release-artifacts-pending-"));
    try {
      copyFileSync(archive, join(promotion, filename));
      const runId = process.env.GITHUB_RUN_ID;
      const hostedRun =
        process.env.GITHUB_ACTIONS === "true" && /^[0-9]+$/u.test(runId ?? "")
          ? { runId }
          : {};
      writeFileSync(
        join(promotion, "upgrade-verification.json"),
        JSON.stringify({ ...identity, upgradedFrom, ...hostedRun }, null, 2) +
          "\n",
      );
      if (existsSync(artifactDirectory)) rmdirSync(artifactDirectory);
      renameSync(promotion, artifactDirectory);
    } finally {
      rmSync(promotion, { recursive: true, force: true });
    }
    process.stdout.write(`Prepared and smoke-tested ${filename}.\n`);
    return join(artifactDirectory, filename);
  } finally {
    rmSync(validateTemporaryRoot(scratch), { recursive: true, force: false });
  }
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  try {
    prepareReleaseArtifact(process.cwd(), {
      smokeOnly: process.argv.includes("--smoke-only"),
    });
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Release artifact preparation failed."}\n`,
    );
    process.exitCode = 1;
  }
}
