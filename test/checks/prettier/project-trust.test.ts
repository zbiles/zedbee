import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createInitProposal } from "../../../src/init/recommend.js";
import { applyInitProposal } from "../../../src/init/write-config.js";
import { rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import {
  canonicalCheckoutRoot,
  canonicalTrustRoot,
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
    expect(await readProjectPrettierTrust(repo.root, "packages/app")).toBe(
      "v1",
    );
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
    const key = projectPrettierTrustKey(
      await canonicalTrustRoot(repo.root),
      ".",
    );
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
    const key = projectPrettierTrustKey(
      await canonicalTrustRoot(repo.root),
      ".",
    );
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

it.each(["new", "legacy-main", "legacy-worktree"])(
  "shares %s consent across branches and worktrees and revokes it everywhere",
  async (grant) => {
    const repo = await createGitRepository();
    await repo.write("package.json", '{"name":"fixture"}');
    await repo.commitAll("fixture");
    const sibling = join(repo.root, "sibling");
    const added = await repo.git([
      "worktree",
      "add",
      "--detach",
      sibling,
      "HEAD",
    ]);
    expect(added.exitCode, added.stderr).toBe(0);
    if (grant === "new") {
      await persistProjectPrettierTrust(sibling, ".");
    } else {
      const checkout = await canonicalCheckoutRoot(
        grant === "legacy-main" ? repo.root : sibling,
      );
      await repo.git([
        "config",
        "--local",
        projectPrettierTrustKey(checkout, "."),
        "v1",
      ]);
    }
    await repo.git(["checkout", "-b", "another-branch"]);
    await expect(
      requireProjectPrettierTrust(repo.root, ".", false),
    ).resolves.toBeDefined();
    const permit = await requireProjectPrettierTrust(sibling, ".", false);
    expect(
      projectPrettierPermitAllows(
        permit,
        await canonicalCheckoutRoot(repo.root),
        ".",
      ),
    ).toBe(false);
    await expect(
      requireProjectPrettierTrust(sibling, "other-project", false),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_TRUST_REQUIRED" });
    const copied = await copyGitRepository(repo.root);
    await expect(
      requireProjectPrettierTrust(copied.root, ".", false),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_TRUST_REQUIRED" });
    await revokeProjectPrettierTrust(sibling, ".");
    for (const root of [repo.root, sibling]) {
      await expect(
        requireProjectPrettierTrust(root, ".", false),
      ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_TRUST_REQUIRED" });
    }
  },
);

it.each([false, true])(
  "restores the prior grant after a later setup grant fails (existing=%s)",
  async (existing) => {
    const repo = await createGitRepository();
    await repo.write("package.json", '{"name":"fixture"}');
    if (existing) await persistProjectPrettierTrust(repo.root, ".");
    const proposal = createInitProposal(await inspectRepository(repo.root), {
      repositoryRoot: repo.root,
      profile: "recommended",
      hook: "none",
      formatting: "project",
      projectPrettierTrustRoots: [".", "../invalid"],
      projectPrettierTrustConfirmed: true,
    });
    await expect(applyInitProposal(proposal)).rejects.toThrow(/rolled back/);
    expect(await readProjectPrettierTrust(repo.root, ".")).toBe(
      existing ? "v1" : undefined,
    );
    await expect(repo.read(".zedbeerc.jsonc")).rejects.toMatchObject({
      code: "ENOENT",
    });
  },
);

it("restores shared and legacy grants when setup revocation rolls back", async () => {
  const repo = await createGitRepository();
  await repo.write("package.json", '{"name":"fixture"}');
  await persistProjectPrettierTrust(repo.root, ".");
  const legacyKey = projectPrettierTrustKey(
    await canonicalCheckoutRoot(repo.root),
    ".",
  );
  await repo.git(["config", "--local", legacyKey, "v1"]);
  const before = await repo.git([
    "config",
    "--local",
    "--get-regexp",
    "allowed",
  ]);
  const proposal = createInitProposal(await inspectRepository(repo.root), {
    repositoryRoot: repo.root,
    profile: "recommended",
    hook: "none",
    formatting: "managed",
    projectPrettierRevokeRoots: [".", "../invalid"],
  });
  await expect(applyInitProposal(proposal)).rejects.toThrow(/rolled back/);
  expect(
    (await repo.git(["config", "--local", "--get-regexp", "allowed"])).stdout,
  ).toBe(before.stdout);
  await expect(
    requireProjectPrettierTrust(repo.root, ".", false),
  ).resolves.toBeDefined();
});

it("does not revive legacy consent when an unavailable worktree returns after revocation", async () => {
  const repo = await createGitRepository();
  await repo.write("package.json", '{"name":"fixture"}');
  await repo.commitAll("fixture");
  const sibling = join(repo.root, "sibling");
  const absent = join(repo.root, "absent");
  expect(
    (await repo.git(["worktree", "add", "--detach", sibling, "HEAD"])).exitCode,
  ).toBe(0);
  const key = projectPrettierTrustKey(
    await canonicalCheckoutRoot(sibling),
    ".",
  );
  await repo.git(["config", "--local", key, "v1"]);
  await persistProjectPrettierTrust(repo.root, ".");
  await rename(sibling, absent);
  await revokeProjectPrettierTrust(repo.root, ".");
  await rename(absent, sibling);
  await expect(
    requireProjectPrettierTrust(sibling, ".", false),
  ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_TRUST_REQUIRED" });
});
