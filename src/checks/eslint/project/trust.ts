import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, posix } from "node:path";
import { GitClient } from "../../../git/client.js";
import { canonicalTrustRoot } from "../../prettier/project-trust.js";
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
async function trustKey(
  root: string,
  projectRoot: string,
  capability: Capability,
): Promise<string> {
  const common = await canonicalTrustRoot(root);
  const digest = createHash("sha256")
    .update(`${common}\0${normalizeProjectRoot(projectRoot)}`)
    .digest("hex");
  return `zedbee.projectEslint-${digest}.${capability}`;
}
async function stored(
  root: string,
  projectRoot: string,
  capability: Capability,
): Promise<boolean> {
  try {
    const key = await trustKey(root, projectRoot, capability);
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
  await new GitClient(root).tryRun([
    "config",
    "--local",
    "--unset-all",
    await trustKey(root, projectRoot, capability),
  ]);
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
  if (!explicitConsent && !(await stored(root, normalized, "execute")))
    throw new ProjectEslintFailureError("PROJECT_ESLINT_TRUST_REQUIRED");
  const permit = Object.freeze({
    projectRoot: normalized,
    [PROJECT_ESLINT_PERMIT_BRAND]: true as const,
  });
  permits.set(permit, {
    checkoutRoot,
    projectRoot: normalized,
    sourceMessages:
      (explicitConsent && options.sourceMessages === true) ||
      (await stored(root, normalized, "messages")),
  });
  return permit;
}
export function projectEslintPermitAllows(
  permit: ProjectEslintPermit,
  checkoutRoot: string,
  projectRoot: string,
  messages = false,
): boolean {
  const recorded =
    typeof permit === "object" && permit !== null
      ? permits.get(permit)
      : undefined;
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
  return (
    typeof permit === "object" &&
    permit !== null &&
    permits.get(permit)?.sourceMessages === true
  );
}
