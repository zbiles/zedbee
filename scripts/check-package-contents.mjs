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
  "docs/checks.md",
  "docs/privacy.md",
  "docs/support.md",
  "docs/commercial-licensing.md",
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

export function packageFilePaths(packOutput) {
  const parsed = JSON.parse(packOutput);
  if (!Array.isArray(parsed) || !Array.isArray(parsed[0]?.files)) {
    throw new Error("npm pack returned invalid JSON");
  }
  return parsed[0].files
    .map((file) => file?.path)
    .filter((path) => typeof path === "string");
}

function main() {
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
  process.stdout.write("Core package contents passed.\n");
}

const entryPoint = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entryPoint === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
