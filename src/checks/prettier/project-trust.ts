import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { posix, resolve } from "node:path";
import { GitClient } from "../../git/client.js";

/**
 * Brand for the permit type. It prevents accidentally passing an arbitrary
 * object where a permit is expected; authority still comes from the private
 * WeakSet below, so a cast or JSON-parsed object is never accepted.
 */
export const PROJECT_PRETTIER_PERMIT_BRAND: unique symbol = Symbol(
  "zedbee.projectPrettierPermit",
);

const PERMIT_ROOTS = new WeakMap<
  object,
  { readonly checkoutRoot: string; readonly projectRoot: string }
>();

export interface ProjectPrettierPermit {
  readonly projectRoot: string;
  readonly [PROJECT_PRETTIER_PERMIT_BRAND]: true;
}

export class ProjectPrettierTrustError extends Error {
  readonly code = "PROJECT_PRETTIER_TRUST_REQUIRED";
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    super(
      "Using the project's Prettier requires explicit trust for this repository. Re-run zedbee init or pass --trust-project-prettier for this invocation.",
    );
    this.name = "ProjectPrettierTrustError";
    this.projectRoot = projectRoot;
    Object.freeze(this);
  }
}

const TRUST_VALUE = "v1";
const TRUST_KEY_PREFIX = "zedbee.projectPrettierTrust";

function normalizeProjectRoot(projectRoot: string): string {
  if (projectRoot === "" || projectRoot === ".") return ".";
  const normalized = posix
    .normalize(projectRoot.replaceAll("\\", "/"))
    .replace(/^\.\//u, "")
    .replace(/\/$/u, "");
  if (
    normalized === "" ||
    normalized === "." ||
    normalized.startsWith("/") ||
    /^[A-Za-z]:/u.test(normalized) ||
    normalized.split("/").includes("..")
  ) {
    throw new TypeError("Expected a repository-relative project root");
  }
  return normalized;
}

export async function canonicalCheckoutRoot(
  repositoryRoot: string,
): Promise<string> {
  return realpath(resolve(repositoryRoot));
}

/** Shared by all worktrees, but distinct for independent clones. */
export async function canonicalTrustRoot(
  repositoryRoot: string,
): Promise<string> {
  const result = await new GitClient(repositoryRoot).run([
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  return realpath(result.stdout);
}

/** Include old checkout-scoped grants without writing during inspection. */
async function trustKeys(
  repositoryRoot: string,
  projectRoot: string,
  revoking = false,
): Promise<readonly string[]> {
  const commonDirectory = await canonicalTrustRoot(repositoryRoot);
  const shared = projectPrettierTrustKey(commonDirectory, projectRoot);
  const worktrees = await new GitClient(repositoryRoot).run([
    "worktree",
    "list",
    "--porcelain",
    "-z",
  ]);
  const keys = [shared];
  for (const field of worktrees.stdout.split("\0")) {
    if (field.startsWith("worktree ")) {
      const path = field.slice("worktree ".length);
      // Revocation also removes grants for temporarily unavailable worktrees,
      // so returning a checkout cannot resurrect withdrawn consent.
      if (revoking) keys.push(projectPrettierTrustKey(path, projectRoot));
      // Old keys used real paths. A removed worktree cannot supply consent.
      const checkout = await realpath(path).catch(() => undefined);
      if (
        checkout !== undefined &&
        (await canonicalTrustRoot(checkout).catch(() => undefined)) ===
          commonDirectory
      ) {
        keys.push(projectPrettierTrustKey(checkout, projectRoot));
      }
    }
  }
  return [...new Set(keys)];
}

export function projectPrettierTrustKey(
  trustRoot: string,
  projectRoot: string,
): string {
  const normalized = normalizeProjectRoot(projectRoot);
  const digest = createHash("sha256")
    .update(`${trustRoot}\0${normalized}`, "utf8")
    .digest("hex");
  return `${TRUST_KEY_PREFIX}-${digest}.allowed`;
}

function mintPermit(
  checkoutRoot: string,
  normalizedProjectRoot: string,
): ProjectPrettierPermit {
  const permit = Object.freeze({
    projectRoot: normalizedProjectRoot,
    [PROJECT_PRETTIER_PERMIT_BRAND]: true as const,
  }) as ProjectPrettierPermit;
  PERMIT_ROOTS.set(permit, {
    checkoutRoot,
    projectRoot: normalizedProjectRoot,
  });
  return permit;
}

export function projectPrettierPermitAllows(
  permit: ProjectPrettierPermit,
  checkoutRoot: string,
  projectRoot: string,
): boolean {
  const recorded = PERMIT_ROOTS.get(permit as object);
  return (
    recorded !== undefined &&
    recorded.checkoutRoot === checkoutRoot &&
    recorded.projectRoot === normalizeProjectRoot(projectRoot)
  );
}

async function readLocalValue(
  repositoryRoot: string,
  key: string,
): Promise<string | undefined> {
  const result = await new GitClient(repositoryRoot).tryRun([
    "config",
    "--local",
    "--no-includes",
    "--get",
    key,
  ]);
  if (result.exitCode !== 0) return undefined;
  const value = result.stdout.trim();
  return value === "" ? undefined : value;
}

export async function readProjectPrettierTrust(
  repositoryRoot: string,
  projectRoot: string,
): Promise<string | undefined> {
  for (const key of await trustKeys(repositoryRoot, projectRoot)) {
    const value = await readLocalValue(repositoryRoot, key);
    if (value === TRUST_VALUE) return value;
  }
  return undefined;
}

export interface ProjectPrettierTrustSnapshot {
  readonly key: string;
  readonly previous: string | undefined;
}

/**
 * Persist local consent. Returns the previous value so a failed setup can
 * restore exactly what was there rather than deleting every trust setting.
 */
export async function persistProjectPrettierTrust(
  repositoryRoot: string,
  projectRoot: string,
): Promise<ProjectPrettierTrustSnapshot> {
  const trustRoot = await canonicalTrustRoot(repositoryRoot);
  const key = projectPrettierTrustKey(trustRoot, projectRoot);
  const previous = await readLocalValue(repositoryRoot, key);
  await new GitClient(repositoryRoot).run([
    "config",
    "--local",
    key,
    TRUST_VALUE,
  ]);
  return Object.freeze({ key, previous });
}

export async function restoreProjectPrettierTrust(
  repositoryRoot: string,
  snapshot: ProjectPrettierTrustSnapshot,
): Promise<void> {
  if (snapshot.previous === undefined) {
    await new GitClient(repositoryRoot).tryRun([
      "config",
      "--local",
      "--unset",
      snapshot.key,
    ]);
    return;
  }
  await new GitClient(repositoryRoot).run([
    "config",
    "--local",
    snapshot.key,
    snapshot.previous,
  ]);
}

export async function revokeProjectPrettierTrust(
  repositoryRoot: string,
  projectRoot: string,
): Promise<readonly ProjectPrettierTrustSnapshot[]> {
  const snapshots: ProjectPrettierTrustSnapshot[] = [];
  try {
    for (const key of await trustKeys(repositoryRoot, projectRoot, true)) {
      const previous = await readLocalValue(repositoryRoot, key);
      if (previous === undefined) continue;
      snapshots.push({ key, previous });
      await new GitClient(repositoryRoot).run([
        "config",
        "--local",
        "--unset",
        key,
      ]);
    }
  } catch (error) {
    for (const snapshot of snapshots)
      await restoreProjectPrettierTrust(repositoryRoot, snapshot);
    throw error;
  }
  return snapshots;
}

export async function requireProjectPrettierTrust(
  repositoryRoot: string,
  projectRoot: string,
  explicitConsent: boolean,
): Promise<ProjectPrettierPermit> {
  const checkoutRoot = await canonicalCheckoutRoot(repositoryRoot);
  const normalized = normalizeProjectRoot(projectRoot);
  if (explicitConsent) {
    // Invocation-only consent; persistence belongs to init's apply path.
    return mintPermit(checkoutRoot, normalized);
  }
  const stored = await readProjectPrettierTrust(repositoryRoot, normalized);
  if (stored !== TRUST_VALUE) {
    throw new ProjectPrettierTrustError(normalized);
  }
  return mintPermit(checkoutRoot, normalized);
}
