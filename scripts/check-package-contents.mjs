import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
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

const PUBLIC_DOCS = Object.freeze([
  "docs/checks.md",
  "docs/commercial-licensing.md",
  "docs/dependency-license-obligations.md",
  "docs/privacy.md",
  "docs/react-analysis.md",
  "docs/readability-complexity.md",
  "docs/structural-security-coverage.md",
  "docs/support.md",
]);

const FIXED_PACKAGE_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "package.json",
  "schema/zedbee.schema.json",
  ...PUBLIC_DOCS,
  "licenses/production-inventory.json",
  "licenses/reviewed-overrides.json",
  "licenses/reviewed-obligations.json",
]);

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

function normalizedPackagePath(path) {
  return path.replaceAll("\\", "/").replace(/^package\//u, "");
}

function buildOutputPaths(sourcePaths) {
  return sourcePaths.flatMap((path) => {
    const normalized = normalizedPackagePath(path);
    if (
      !normalized.startsWith("src/") ||
      !/\.(?:ts|tsx)$/u.test(normalized) ||
      normalized.endsWith(".d.ts")
    ) {
      throw new TypeError(`Invalid source module path: ${normalized}`);
    }
    const stem = `dist/${normalized.slice("src/".length).replace(/\.(?:ts|tsx)$/u, "")}`;
    return [`${stem}.js`, `${stem}.js.map`, `${stem}.d.ts`, `${stem}.d.ts.map`];
  });
}

export function assertAllowedPackageFiles(paths, options) {
  const allowed = new Set([
    ...FIXED_PACKAGE_FILES,
    ...options.reviewedOverridePaths.map(normalizedPackagePath),
    ...buildOutputPaths(options.sourcePaths),
  ]);
  const unexpected = paths
    .map(normalizedPackagePath)
    .filter((path) => !allowed.has(path));
  if (unexpected.length > 0) {
    throw new Error(
      `Package contains unapproved files: ${unexpected.join(", ")}`,
    );
  }
}

export function assertPackMetadata(packOutput, expectedVersion) {
  const parsed = JSON.parse(packOutput);
  const record = parsed[0];
  if (
    !Array.isArray(parsed) ||
    parsed.length !== 1 ||
    record?.name !== "zedbee" ||
    record?.version !== expectedVersion
  ) {
    throw new Error("Package identity does not match the release manifest.");
  }
  if (!Array.isArray(record.bundled) || record.bundled.length > 0) {
    throw new Error("Package must not contain bundled dependencies.");
  }
}

function sourceModulePaths(root) {
  const sourceRoot = join(root, "src");
  const paths = [];
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (
        entry.isFile() &&
        /\.(?:ts|tsx)$/u.test(entry.name) &&
        !entry.name.endsWith(".d.ts")
      ) {
        paths.push(relative(root, path).replaceAll("\\", "/"));
      } else if (entry.isSymbolicLink()) {
        throw new Error("Source modules must not contain symbolic links.");
      }
    }
  };
  visit(sourceRoot);
  return paths.sort();
}

export function assertRequiredPackageFiles(paths) {
  const normalizedPaths = paths.map(normalizedPackagePath);
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
    const packagePaths = packageFilePaths(coreOutput);
    assertRequiredPackageFiles(packagePaths);
    assertAllowedPackageFiles(packagePaths, {
      sourcePaths: sourceModulePaths(root),
      reviewedOverridePaths: reviewedOverrideTexts,
    });
    const corePackage = JSON.parse(
      readFileSync(resolve(root, "package.json"), "utf8"),
    );
    assertPackMetadata(coreOutput, corePackage.version);
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
