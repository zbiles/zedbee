import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const reviewedOverrides = JSON.parse(
  readFileSync(
    new URL("../licenses/reviewed-overrides.json", import.meta.url),
    "utf8",
  ),
);
const reviewedOverrideTexts = [
  ...new Set(reviewedOverrides.overrides.map((override) => override.textFile)),
].sort();

export const REQUIRED_PACKAGE_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "schema/zedbee.schema.json",
  "licenses/production-inventory.json",
  "licenses/reviewed-overrides.json",
  "licenses/reviewed-obligations.json",
  ...reviewedOverrideTexts,
  "dist/cli.js",
  "dist/index.js",
  "dist/index.d.ts",
]);

export function assertRequiredPackageFiles(paths) {
  const normalizedPaths = paths.map((path) =>
    path.replaceAll("\\", "/").replace(/^package\//u, ""),
  );
  const normalized = new Set(normalizedPaths);
  const missing = REQUIRED_PACKAGE_FILES.filter(
    (path) => !normalized.has(path),
  );
  if (missing.length > 0) {
    throw new Error(`Package is missing required files: ${missing.join(", ")}`);
  }
  const forbidden = normalizedPaths.filter(
    (path) =>
      /^(?:src|test|scripts|packages)\//u.test(path) ||
      /(?:^|\/)(?:raw-report|jscpd-report|gitleaks-report|osv-report)\b/iu.test(
        path,
      ),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Package contains forbidden files: ${forbidden.join(", ")}`,
    );
  }
}

function record(value) {
  return typeof value === "object" && value !== null ? value : undefined;
}

export function assertPlatformPackageArtifact(paths, packageJson, manifest) {
  const metadata = record(packageJson);
  const embedded = record(manifest);
  const expectedLicense =
    embedded?.engine === "gitleaks"
      ? "MIT"
      : embedded?.engine === "osv-scanner"
        ? "Apache-2.0"
        : undefined;
  if (expectedLicense === undefined || metadata?.license !== expectedLicense) {
    throw new Error(
      `Managed platform package must declare ${expectedLicense ?? "a reviewed engine license"}.`,
    );
  }
  if (
    typeof embedded.executablePath !== "string" ||
    !/^[a-f0-9]{64}$/u.test(String(embedded.executableSha256)) ||
    (embedded.configPath !== undefined &&
      (typeof embedded.configPath !== "string" ||
        !/^[a-f0-9]{64}$/u.test(String(embedded.configSha256))))
  ) {
    throw new Error("Managed platform package has invalid checksum metadata.");
  }
  const normalizedPaths = paths.map((path) =>
    path.replaceAll("\\", "/").replace(/^package\//u, ""),
  );
  const required = [
    "LICENSE",
    "THIRD_PARTY_NOTICES.md",
    "manifest.json",
    "package.json",
    embedded.executablePath,
    ...(typeof embedded.configPath === "string" ? [embedded.configPath] : []),
  ];
  const present = new Set(normalizedPaths);
  const missing = required.filter((path) => !present.has(path));
  if (missing.length > 0) {
    throw new Error(
      `Managed platform package is missing required files: ${missing.join(", ")}`,
    );
  }
  const forbidden = normalizedPaths.filter(
    (path) =>
      /^(?:src|test|scripts|packages)\//u.test(path) ||
      /(?:^|\/)(?:raw-report|jscpd-report|gitleaks-report|osv-report)\b/iu.test(
        path,
      ),
  );
  if (forbidden.length > 0) {
    throw new Error(
      `Managed platform package contains forbidden files: ${forbidden.join(", ")}`,
    );
  }
}

export function packageFilePaths(packOutput) {
  const parsed = JSON.parse(packOutput);
  if (!Array.isArray(parsed) || !Array.isArray(parsed[0]?.files)) {
    throw new Error("npm pack returned invalid JSON");
  }
  return parsed[0].files
    .map((file) => file?.path)
    .filter((path) => typeof path === "string");
}

function main(includePlatforms = false) {
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  const temporaryRoot = mkdtempSync(join(tmpdir(), "zedbee-package-check-"));
  const temporaryCache = join(temporaryRoot, "npm-cache");
  const artifactDirectory = join(temporaryRoot, "artifacts");
  try {
    mkdirSync(artifactDirectory);
    const root = process.cwd();
    const pack = (directory) => {
      const packed = spawnSync(
        npmCommand,
        [
          "pack",
          directory,
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          artifactDirectory,
        ],
        {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, npm_config_cache: temporaryCache },
        },
      );
      if (packed.status !== 0) {
        throw new Error(packed.stderr || `npm pack failed for ${directory}`);
      }
      const metadata = JSON.parse(packed.stdout);
      const filename = metadata[0]?.filename;
      if (
        typeof filename !== "string" ||
        basename(filename) !== filename ||
        !statSync(resolve(artifactDirectory, filename)).isFile()
      ) {
        throw new Error(
          `npm pack did not create a safe artifact for ${directory}`,
        );
      }
      return packed.stdout;
    };
    const coreOutput = pack(root);
    assertRequiredPackageFiles(packageFilePaths(coreOutput));
    const corePackage = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    );
    if (corePackage.license !== "PolyForm-Small-Business-1.0.0") {
      throw new Error(
        "Core package must declare PolyForm-Small-Business-1.0.0.",
      );
    }
    const matching = includePlatforms
      ? JSON.parse(
          readFileSync(
            resolve(root, "packages/managed-binary/manifest.json"),
            "utf8",
          ),
        ).entries?.filter(
          (entry) =>
            entry.platform === process.platform && entry.arch === process.arch,
        )
      : [];
    if (
      includePlatforms &&
      (!Array.isArray(matching) ||
        matching.length !== 2 ||
        new Set(matching.map(({ engine }) => engine)).size !== 2)
    ) {
      throw new Error(
        `Expected matching Gitleaks and OSV-Scanner packages for ${process.platform}-${process.arch}.`,
      );
    }
    for (const entry of matching) {
      const directory = resolve(
        root,
        "packages",
        entry.packageName.replace("@zedbee/", ""),
      );
      const output = pack(directory);
      const packageJson = JSON.parse(
        readFileSync(resolve(directory, "package.json"), "utf8"),
      );
      const manifest = JSON.parse(
        readFileSync(resolve(directory, "manifest.json"), "utf8"),
      );
      assertPlatformPackageArtifact(
        packageFilePaths(output),
        packageJson,
        manifest,
      );
      const notice = readFileSync(
        resolve(directory, "THIRD_PARTY_NOTICES.md"),
        "utf8",
      );
      if (
        (entry.engine === "gitleaks" && !notice.includes("MIT License")) ||
        (entry.engine === "osv-scanner" &&
          !notice.includes("Apache License 2.0"))
      ) {
        throw new Error(
          `Managed platform package has invalid notices: ${entry.packageName}`,
        );
      }
    }
  } finally {
    const canonicalTemp = realpathSync(tmpdir());
    const canonicalRoot = realpathSync(temporaryRoot);
    if (
      dirname(canonicalRoot) !== canonicalTemp ||
      !basename(canonicalRoot).startsWith("zedbee-package-check-") ||
      !lstatSync(canonicalRoot).isDirectory()
    ) {
      throw new Error("Refused to clean an invalid package-check path.");
    }
    rmSync(canonicalRoot, { recursive: true, force: false });
  }
  process.stdout.write(
    includePlatforms
      ? "Core and matching platform package contents passed.\n"
      : "Core package contents passed.\n",
  );
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  try {
    main(process.argv.includes("--platforms"));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
