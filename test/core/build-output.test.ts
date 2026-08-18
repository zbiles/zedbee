import {
  access,
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { cleanBuildOutput } from "../../scripts/clean-build-output.mjs";

describe("cleanBuildOutput", () => {
  it("removes only the real dist directory beneath the project root", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-build-clean-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "dist", "stale.js"), "stale\n");

    cleanBuildOutput(root);

    await expect(access(join(root, "dist"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(root)).resolves.toBeUndefined();
  });

  it.runIf(process.platform !== "win32")(
    "refuses a dist symlink without touching its target",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "zedbee-build-clean-"));
      const target = await mkdtemp(join(tmpdir(), "zedbee-build-target-"));
      onTestFinished(async () => {
        await rm(root, { recursive: true, force: true });
        await rm(target, { recursive: true, force: true });
      });
      await writeFile(join(target, "preserved.js"), "preserved\n");
      await symlink(target, join(root, "dist"), "dir");

      expect(() => cleanBuildOutput(root)).toThrow(/invalid build-output/u);
      await expect(
        access(join(target, "preserved.js")),
      ).resolves.toBeUndefined();
    },
  );
});
