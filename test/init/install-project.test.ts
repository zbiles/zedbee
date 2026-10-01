import { describe, expect, it } from "vitest";
import { createGitRepository } from "../helpers/git-repository.js";
import { projectInstallTargets } from "../../src/init/install-project.js";
import { ZEDBEE_VERSION } from "../../src/core/package-version.js";

describe("project installation targets", () => {
  it("offers eligible folders and identifies their formatter and package manager", async () => {
    const repo = await createGitRepository();
    await repo.write("e2e/package.json", '{"name":"tests"}');
    await repo.write(
      "web/package.json",
      '{"name":"web","packageManager":"pnpm@10.0.0"}',
    );
    await repo.write("web/.prettierrc.json", "{}");
    const targets = await projectInstallTargets(repo.root, ["e2e", "web"]);
    expect(targets).toEqual([
      expect.objectContaining({
        projectRoot: "e2e",
        manager: "npm",
        hasPrettier: false,
      }),
      expect.objectContaining({
        projectRoot: "web",
        manager: "pnpm",
        hasPrettier: true,
      }),
    ]);
    expect(targets[1]?.args).toContain(`zedbee@${ZEDBEE_VERSION}`);
  });
  it("inherits a workspace manager from the repository root", async () => {
    const repo = await createGitRepository();
    await repo.write(
      "package.json",
      '{"private":true,"packageManager":"yarn@4.0.0","workspaces":["web"]}',
    );
    await repo.write("web/package.json", '{"name":"web"}');
    const [target] = await projectInstallTargets(repo.root, ["web"]);
    expect(target?.manager).toBe("yarn");
    expect(target?.projectRoot).toBe("web");
  });
});
