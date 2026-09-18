import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  canonicalCheckoutRoot,
  persistProjectPrettierTrust,
  projectPrettierPermitAllows,
  projectPrettierTrustKey,
  readProjectPrettierTrust,
  requireProjectPrettierTrust,
  restoreProjectPrettierTrust,
  revokeProjectPrettierTrust,
  type ProjectPrettierPermit,
} from "../../../src/checks/prettier/project-trust.js";
import {
  copyGitRepository,
  createGitRepository,
} from "../../helpers/git-repository.js";

describe("project Prettier trust", () => {
  it("mints a permit for explicit invocation consent", async () => {
    const repo = await createGitRepository();

    const permit = await requireProjectPrettierTrust(repo.root, ".", true);

    expect(permit.projectRoot).toBe(".");
    const checkoutRoot = await canonicalCheckoutRoot(repo.root);
    expect(projectPrettierPermitAllows(permit, checkoutRoot, ".")).toBe(true);
  });

  it("rejects without stored or explicit consent", async () => {
    const repo = await createGitRepository();

    await expect(
      requireProjectPrettierTrust(repo.root, ".", false),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_TRUST_REQUIRED" });
  });

  it("keeps explicit consent invocation-only", async () => {
    const repo = await createGitRepository();

    await requireProjectPrettierTrust(repo.root, ".", true);

    expect(await readProjectPrettierTrust(repo.root, ".")).toBeUndefined();
    await expect(
      requireProjectPrettierTrust(repo.root, ".", false),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_TRUST_REQUIRED" });
  });

  it("honors persisted local consent and revocation", async () => {
    const repo = await createGitRepository();

    await persistProjectPrettierTrust(repo.root, "packages/app");
    expect(await readProjectPrettierTrust(repo.root, "packages/app")).toBe("v1");
    await expect(
      requireProjectPrettierTrust(repo.root, "packages/app", false),
    ).resolves.toBeDefined();

    await revokeProjectPrettierTrust(repo.root, "packages/app");
    await expect(
      requireProjectPrettierTrust(repo.root, "packages/app", false),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_TRUST_REQUIRED" });
  });

  it("restores the previous trust value rather than deleting it", async () => {
    const repo = await createGitRepository();
    const snapshot = await persistProjectPrettierTrust(repo.root, ".");
    await restoreProjectPrettierTrust(repo.root, snapshot);

    expect(await readProjectPrettierTrust(repo.root, ".")).toBeUndefined();

    const first = await persistProjectPrettierTrust(repo.root, ".");
    const second = await persistProjectPrettierTrust(repo.root, ".");
    expect(second.previous).toBe("v1");
    await restoreProjectPrettierTrust(repo.root, second);
    expect(await readProjectPrettierTrust(repo.root, ".")).toBe("v1");
    expect(first.key).toBe(second.key);
  });

  it("does not read global Git configuration as consent", async () => {
    const repo = await createGitRepository();
    const checkoutRoot = await canonicalCheckoutRoot(repo.root);
    const key = projectPrettierTrustKey(checkoutRoot, ".");
    const globalConfig = join(repo.root, "global.gitconfig");
    await writeFile(globalConfig, "", "utf8");
    await repo.git(["config", "--file", globalConfig, key, "v1"]);

    const previousGlobal = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    onTestFinished(() => {
      if (previousGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobal;
    });

    await expect(
      requireProjectPrettierTrust(repo.root, ".", false),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_TRUST_REQUIRED" });
  });

  it("does not follow local config includes for consent", async () => {
    const repo = await createGitRepository();
    const checkoutRoot = await canonicalCheckoutRoot(repo.root);
    const key = projectPrettierTrustKey(checkoutRoot, ".");
    const included = join(repo.root, "included.gitconfig");
    await writeFile(included, "", "utf8");
    await repo.git(["config", "--file", included, key, "v1"]);
    await repo.git(["config", "--local", "include.path", included]);

    await expect(
      requireProjectPrettierTrust(repo.root, ".", false),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_TRUST_REQUIRED" });
  });

  it("requires its own consent in a fresh checkout copy", async () => {
    const repo = await createGitRepository();
    await persistProjectPrettierTrust(repo.root, ".");

    const clone = await copyGitRepository(repo.root);

    await expect(
      requireProjectPrettierTrust(clone.root, ".", false),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_TRUST_REQUIRED" });
  });

  it("does not accept a forged permit object", async () => {
    const repo = await createGitRepository();
    const forged = {
      projectRoot: ".",
    } as unknown as ProjectPrettierPermit;
    const checkoutRoot = await canonicalCheckoutRoot(repo.root);

    expect(projectPrettierPermitAllows(forged, checkoutRoot, ".")).toBe(false);
  });
});
