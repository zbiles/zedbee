import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
import { GitClient } from "../../../git/client.js";
import { canonicalTrustRoot } from "../../../git/common-directory.js";
import { ProjectEslintFailureError } from "./types.js";

export const PROJECT_ESLINT_PERMIT_BRAND: unique symbol = Symbol(
  "zedbee.projectEslintPermit",
);
export interface ProjectEslintPermit {
  readonly projectRoot: string;
  readonly [PROJECT_ESLINT_PERMIT_BRAND]: true;
}
const permits = new WeakMap<
  object,
  { checkoutRoot: string; projectRoot: string; sourceMessages: boolean }
>();
function recordedPermit(permit: ProjectEslintPermit) {
  return typeof permit === "object" && permit !== null
    ? permits.get(permit)
    : undefined;
}
export function normalizeProjectRoot(root: string): string {
  const path = root.replaceAll("\\", "/");
  if (
    isAbsolute(path) ||
    /^[A-Za-z]:/u.test(path) ||
    path.split("/").includes("..")
  )
    throw new ProjectEslintFailureError("PROJECT_ESLINT_LAYOUT_UNSUPPORTED");
  return posix.normalize(path || ".").replace(/\/$/u, "") || ".";
}
type Capability = "execute" | "messages";
function capabilityKey(
  common: string,
  projectRoot: string,
  capability: Capability,
): string {
  const digest = createHash("sha256")
    .update(`${common}\0${normalizeProjectRoot(projectRoot)}`)
    .digest("hex");
  return `zedbee.projectEslint-${digest}.${capability}`;
}
async function trustKey(
  root: string,
  projectRoot: string,
  capability: Capability,
): Promise<string> {
  return capabilityKey(await canonicalTrustRoot(root), projectRoot, capability);
}
async function storedKey(root: string, key: string): Promise<boolean> {
  try {
    const value = await new GitClient(root).tryRun([
      "config",
      "--local",
      "--no-includes",
      "--get",
      key,
    ]);
    return value.exitCode === 0 && value.stdout.trim() === "v1";
  } catch {
    return false;
  }
}
async function stored(
  root: string,
  projectRoot: string,
  capability: Capability,
): Promise<boolean> {
  const key = await trustKey(root, projectRoot, capability).catch(
    () => undefined,
  );
  return key === undefined ? false : storedKey(root, key);
}
export async function hasProjectEslintTrust(
  root: string,
  projectRoot: string,
  capability: Capability = "execute",
): Promise<boolean> {
  return stored(root, projectRoot, capability);
}
export async function revokeProjectEslintCapability(
  root: string,
  projectRoot: string,
  capability: Capability,
): Promise<void> {
  const result = await new GitClient(root).tryRun([
    "config",
    "--local",
    "--unset-all",
    await trustKey(root, projectRoot, capability),
  ]);
  // Git returns 5 when the key is already absent.
  if (result.exitCode !== 0 && result.exitCode !== 5)
    throw new Error("Could not remove the local project ESLint trust grant.");
}
export async function persistProjectEslintTrust(
  root: string,
  projectRoot: string,
  capability: Capability = "execute",
): Promise<void> {
  await new GitClient(root).run([
    "config",
    "--local",
    await trustKey(root, projectRoot, capability),
    "v1",
  ]);
}
export async function revokeProjectEslintTrust(
  root: string,
  projectRoot: string,
): Promise<void> {
  for (const capability of ["execute", "messages"] as const)
    await revokeProjectEslintCapability(root, projectRoot, capability);
}
export async function requireProjectEslintTrust(
  root: string,
  projectRoot: string,
  explicitConsent = false,
  options: { readonly sourceMessages?: boolean } = {},
): Promise<ProjectEslintPermit> {
  const checkoutRoot = await realpath(root),
    normalized = normalizeProjectRoot(projectRoot);
  const common = await canonicalTrustRoot(root).catch(() => undefined);
  const isStored = async (capability: Capability): Promise<boolean> =>
    common === undefined
      ? false
      : storedKey(root, capabilityKey(common, normalized, capability));
  const [executeAllowed, messagesAllowed] = await Promise.all([
    explicitConsent ? Promise.resolve(true) : isStored("execute"),
    explicitConsent && options.sourceMessages === true
      ? Promise.resolve(true)
      : isStored("messages"),
  ]);
  if (!executeAllowed)
    throw new ProjectEslintFailureError("PROJECT_ESLINT_TRUST_REQUIRED");
  const permit = Object.freeze({
    projectRoot: normalized,
    [PROJECT_ESLINT_PERMIT_BRAND]: true as const,
  });
  permits.set(permit, {
    checkoutRoot,
    projectRoot: normalized,
    sourceMessages: messagesAllowed,
  });
  return permit;
}
export function projectEslintPermitAllows(
  permit: ProjectEslintPermit,
  checkoutRoot: string,
  projectRoot: string,
  messages = false,
): boolean {
  const recorded = recordedPermit(permit);
  return (
    recorded !== undefined &&
    recorded.checkoutRoot === checkoutRoot &&
    recorded.projectRoot === normalizeProjectRoot(projectRoot) &&
    (!messages || recorded.sourceMessages)
  );
}
export function projectEslintSourceMessagesAllowed(
  permit: ProjectEslintPermit,
): boolean {
  return recordedPermit(permit)?.sourceMessages === true;
}
