import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const TEMPORARY_PREFIX = "zedbee-release-smoke-";
const MAX_COMMAND_OUTPUT = 16 * 1024 * 1024;

function executable(command) {
  return process.platform === "win32" && command === "npm"
    ? "npm.cmd"
    : command;
}

function run(command, args, options) {
  const result = spawnSync(executable(command), args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: options.env ?? process.env,
    timeout: options.timeout ?? 180_000,
    maxBuffer: MAX_COMMAND_OUTPUT,
  });
  const expectedStatuses = options.expectedStatuses ?? [0];
  if (!expectedStatuses.includes(result.status)) {
    const detail = (result.stderr || result.stdout || "No output").trim();
    throw new Error(`${options.label} failed.\n${detail}`);
  }
  return result.stdout;
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
    if (!hook.includes("npx --no-install zedbee scan")) {
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
    run(
      "git",
      ["commit", "--no-gpg-sign", "-m", "base-mode fixture policy"],
      { cwd: fixture, label: "Base-mode fixture commit" },
    );
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

export function prepareReleaseArtifact(cwd = process.cwd()) {
  const root = realpathSync(cwd);
  const artifactDirectory = join(root, "release-artifacts");
  if (!readdirSync(root).includes("release-artifacts")) {
    mkdirSync(artifactDirectory);
  } else {
    const metadata = lstatSync(artifactDirectory);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Release artifact destination must be a real directory.");
    }
  }
  if (readdirSync(artifactDirectory).length !== 0) {
    throw new Error(
      "Release artifact destination is not empty; remove its previous contents and retry.",
    );
  }

  const manifest = parseJson(
    readFileSync(join(root, "package.json"), "utf8"),
    "Release manifest",
  );
  const packTemp = mkdtempSync(join(tmpdir(), TEMPORARY_PREFIX));
  let filename;
  try {
    const output = run(
      "npm",
      [
        "pack",
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        artifactDirectory,
      ],
      {
        cwd: root,
        env: { ...process.env, npm_config_cache: join(packTemp, "npm-cache") },
        label: "Release artifact packing",
      },
    );
    filename = releaseArtifactFilename(output, manifest);
  } finally {
    rmSync(validateTemporaryRoot(packTemp), { recursive: true, force: false });
  }
  const artifactPath = resolve(artifactDirectory, filename);
  const artifactMetadata = lstatSync(artifactPath);
  if (
    artifactMetadata.isSymbolicLink() ||
    !artifactMetadata.isFile() ||
    dirname(artifactPath) !== artifactDirectory
  ) {
    throw new Error("npm produced an unsafe release artifact path.");
  }
  smokeReleaseArtifact(artifactPath, manifest);
  process.stdout.write(`Prepared and smoke-tested ${filename}.\n`);
  return artifactPath;
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  try {
    prepareReleaseArtifact();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Release artifact preparation failed."}\n`,
    );
    process.exitCode = 1;
  }
}
