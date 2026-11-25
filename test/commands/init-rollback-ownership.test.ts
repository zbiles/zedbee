import { chmod, lstat, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderInitFailure } from "../../src/init/presentation.js";
import { applyInitProposal } from "../../src/init/write-config.js";
import {
  createInitProposal,
  initFileChange,
} from "../../src/init/recommend.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("init rollback ownership", () => {
  it.each(["modified", "new", "mode", "replaced", "ordinary"] as const)(
    "preserves user changes while undoing independent writes: %s",
    async (kind) => {
      if (kind === "mode" && process.platform === "win32") return;
      const repo = await createGitRepository();
      const config = ".zedbeerc.jsonc";
      const manifest = "package.json";
      const original = '{"name":"fixture"}\n';
      const proposed = '{"name":"fixture","private":true}\n';
      const user = '{"name":"user-edited"}\n';
      if (kind !== "new") await repo.write(manifest, original);
      await repo.git(["add", "--all"]);
      const indexBefore = await repo.git(["ls-files", "--stage"]);
      const initial = createInitProposal(await inspectRepository(repo.root), {
        repositoryRoot: repo.root,
        profile: "recommended",
        hook: "none",
      });
      const proposal = {
        ...initial,
        files: [
          initFileChange(
            manifest,
            kind === "new" ? null : original,
            proposed,
            0o644,
          ),
          initFileChange(config, null, "{}\n", 0o644),
          initFileChange("lefthook.yml", null, "pre-commit: {}\n", 0o644),
        ],
      };
      const path = join(repo.root, manifest);
      const failure = applyInitProposal(proposal, {
        beforeWrite: async (index) => {
          if (index !== 2) return;
          if (kind === "modified" || kind === "new")
            await writeFile(path, user);
          if (kind === "mode") await chmod(path, 0o600);
          if (kind === "replaced") {
            await rename(path, join(repo.root, "prior-manifest"));
            await writeFile(path, proposed);
          }
          throw new Error("injected later write failure");
        },
      });
      if (kind === "ordinary")
        await expect(failure).rejects.toThrow(/was rolled back/u);
      else {
        const error = await failure.catch((error: unknown) => error);
        expect(error).toMatchObject({ incompletePaths: [manifest] });
        expect(renderInitFailure(error)).toMatch(
          /rollback was incomplete.*package\.json/u,
        );
      }
      expect(await readFile(path, "utf8")).toBe(
        kind === "ordinary"
          ? original
          : kind === "modified" || kind === "new"
            ? user
            : proposed,
      );
      if (kind === "mode") expect((await lstat(path)).mode & 0o777).toBe(0o600);
      await expect(readFile(join(repo.root, config))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await repo.git(["ls-files", "--stage"])).toEqual(indexBefore);
    },
  );
});
