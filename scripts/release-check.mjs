import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { commandInvocation } from "./command-invocation.mjs";

export { commandInvocation, resolveNpmCliPath } from "./command-invocation.mjs";

const OWNER_ACTION =
  "Release blocked: add the canonical HTTPS repository.url, homepage, and bugs.url to package.json and configure the matching Git remote.";
const PACKAGE_ACTION =
  "Release blocked: package name, version, access, and registry must identify the public zedbee release.";
const RELEASE_VERSION =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;

const LOCAL_STEPS = Object.freeze([
  { id: "typecheck", command: "npm", args: ["run", "typecheck"] },
  { id: "build", command: "npm", args: ["run", "build"] },
  {
    id: "tests",
    command: "node",
    args: ["node_modules/vitest/vitest.mjs", "run"],
  },
  {
    id: "schema",
    command: "node",
    args: ["dist/config/json-schema.js", "--check"],
  },
  { id: "licenses", command: "npm", args: ["run", "licenses:check"] },
  {
    id: "benchmark",
    command: "node",
    args: ["--experimental-strip-types", "bench/run.mts"],
  },
  {
    id: "package",
    command: "node",
    args: ["scripts/check-package-contents.mjs"],
  },
  {
    id: "diff",
    command: "git",
    args: ["--no-pager", "diff", "--check"],
  },
]);

export function verificationSteps(mode = "verify") {
  if (mode !== "verify" && mode !== "release") {
    throw new TypeError("Unknown release verification mode.");
  }
  const steps =
    mode === "release"
      ? [
          {
            id: "dependency-audit",
            command: "npm",
            args: [
              "audit",
              "--omit=dev",
              "--ignore-scripts",
              "--audit-level=high",
            ],
          },
          ...LOCAL_STEPS,
        ]
      : LOCAL_STEPS;
  return steps.map((step) =>
    Object.freeze({ ...step, args: Object.freeze([...step.args]) }),
  );
}

export function packageManagerInstall(manager, tarball) {
  if (!["npm", "pnpm", "yarn", "bun"].includes(manager)) {
    throw new TypeError("Unsupported package manager.");
  }
  if (
    typeof tarball !== "string" ||
    tarball.length === 0 ||
    tarball.includes("\0")
  ) {
    throw new TypeError("Invalid package tarball path.");
  }
  return Object.freeze({
    command: manager,
    args: Object.freeze([
      manager === "npm" ? "install" : "add",
      "--ignore-scripts",
      tarball,
    ]),
  });
}

function repositoryUrl(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.url === "string") {
    return value.url;
  }
  return undefined;
}

function bugsUrl(value) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.url === "string") {
    return value.url;
  }
  return undefined;
}

function canonicalHttps(value) {
  if (typeof value !== "string" || !value.startsWith("https://")) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      url.username !== "" ||
      url.password !== "" ||
      url.hostname === "example.com" ||
      url.hostname.endsWith(".example.com") ||
      /(?:todo|placeholder|your[-_]?org)/iu.test(url.href)
    ) {
      return undefined;
    }
    return url;
  } catch {
    return undefined;
  }
}

function normalizedRepository(value) {
  if (typeof value !== "string") return undefined;
  let normalized = value.trim();
  const ssh = /^git@([^:]+):(.+)$/u.exec(normalized);
  if (ssh !== null) normalized = `https://${ssh[1]}/${ssh[2]}`;
  normalized = normalized.replace(/^git\+/u, "");
  const url = canonicalHttps(normalized);
  if (url === undefined || url.search !== "" || url.hash !== "") {
    return undefined;
  }
  url.pathname = url.pathname.replace(/\.git\/?$/u, "").replace(/\/$/u, "");
  return url;
}

function sameRepository(left, right) {
  return left.origin === right.origin && left.pathname === right.pathname;
}

function repositoryPage(repository, page) {
  if (page === undefined || page.origin !== repository.origin) return false;
  return (
    page.pathname === repository.pathname ||
    page.pathname.startsWith(`${repository.pathname}/`)
  );
}

export function releaseReadiness(packageJson, remoteUrls) {
  const publishConfig = packageJson?.publishConfig;
  if (
    packageJson?.name !== "zedbee" ||
    typeof packageJson?.version !== "string" ||
    packageJson.version === "0.0.0" ||
    !RELEASE_VERSION.test(packageJson.version) ||
    publishConfig?.access !== "public" ||
    publishConfig?.registry !== "https://registry.npmjs.org/"
  ) {
    return Object.freeze({ ready: false, message: PACKAGE_ACTION });
  }
  const repository = normalizedRepository(
    repositoryUrl(packageJson?.repository),
  );
  const homepage = canonicalHttps(packageJson?.homepage);
  const bugs = canonicalHttps(bugsUrl(packageJson?.bugs));
  const remotes = Array.isArray(remoteUrls)
    ? remoteUrls.map(normalizedRepository).filter(Boolean)
    : [];
  const related =
    repository !== undefined &&
    repositoryPage(repository, homepage) &&
    repositoryPage(repository, bugs) &&
    remotes.some((remote) => sameRepository(repository, remote));
  return related
    ? Object.freeze({ ready: true })
    : Object.freeze({ ready: false, message: OWNER_ACTION });
}

function run(step, cwd, capture = false) {
  const environment =
    step.id === "tests" &&
    process.env.ZEDBEE_PACKAGE_MANAGER_UNDER_TEST === undefined
      ? { ...process.env, ZEDBEE_PACKAGE_MANAGER_UNDER_TEST: "npm" }
      : process.env;
  const invocation = commandInvocation(step.command, step.args);
  const result = spawnSync(invocation.executable, invocation.args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    env: environment,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Verification failed at ${step.id}.`);
  }
  return result.stdout ?? "";
}

function gitRemotes(cwd) {
  const names = run(
    { id: "git-remotes", command: "git", args: ["remote"] },
    cwd,
    true,
  )
    .split(/\r?\n/u)
    .filter(Boolean);
  return names.flatMap((name) => {
    const result = spawnSync("git", ["remote", "get-url", "--all", name], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return result.status === 0
      ? result.stdout.split(/\r?\n/u).filter(Boolean)
      : [];
  });
}

function assertReleaseOnlyGates(cwd) {
  const sbom = run(
    {
      id: "sbom",
      command: "npm",
      args: ["sbom", "--sbom-format", "spdx"],
    },
    cwd,
    true,
  );
  const parsed = JSON.parse(sbom);
  if (parsed?.spdxVersion === undefined || parsed?.SPDXID === undefined) {
    throw new Error("Verification failed at sbom.");
  }
  const status = run(
    { id: "clean-status", command: "git", args: ["status", "--porcelain"] },
    cwd,
    true,
  );
  if (status !== "") throw new Error("Verification failed at clean-status.");
  if (process.env.ZEDBEE_CROSS_PLATFORM_CI_EVIDENCE !== "verified") {
    throw new Error(
      "Release blocked: successful Node 22/24 Ubuntu, macOS, and Windows release-check CI evidence is required.",
    );
  }
}

export function runVerification(mode, cwd = process.cwd()) {
  if (mode === "release") {
    const packageJson = JSON.parse(
      readFileSync(resolve(cwd, "package.json"), "utf8"),
    );
    assertReleaseTag(packageJson.version);
    const readiness = releaseReadiness(packageJson, gitRemotes(cwd));
    if (!readiness.ready) throw new Error(readiness.message);
  }
  for (const step of verificationSteps(mode)) run(step, cwd);
  if (mode === "release") assertReleaseOnlyGates(cwd);
}

export function assertReleaseTag(version, ref = process.env.GITHUB_REF ?? "") {
  if (ref.startsWith("refs/tags/") && ref !== `refs/tags/v${version}`) {
    throw new Error(
      `Release tag ${ref.slice("refs/tags/".length)} does not match package version ${version}.`,
    );
  }
}

function main() {
  if (process.argv.includes("--tag-check")) {
    const manifest = JSON.parse(
      readFileSync(resolve(process.cwd(), "package.json"), "utf8"),
    );
    assertReleaseTag(manifest.version);
    process.stdout.write("Release tag check passed.\n");
    return;
  }
  const mode = process.argv.includes("--release") ? "release" : "verify";
  runVerification(mode);
  process.stdout.write(
    mode === "release"
      ? "Release verification passed.\n"
      : "Local verification passed.\n",
  );
}

const entry = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : undefined;
if (entry === import.meta.url) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : "Release verification failed."}\n`,
    );
    process.exitCode = 1;
  }
}
