import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  copyGitRepository,
  createGitRepository,
} from "./git-repository.js";

describe("createGitRepository", () => {
  it("copies the prepared repository without running Git setup commands", async () => {
    const originalPath = process.env.PATH;
    process.env.PATH = "";
    try {
      const repository = await createGitRepository();
      const [head, config] = await Promise.all([
        readFile(join(repository.root, ".git", "HEAD"), "utf8"),
        readFile(join(repository.root, ".git", "config"), "utf8"),
      ]);

      expect(head).toBe("ref: refs/heads/main\n");
      expect(config).toContain("name = Zedbee Test");
      expect(config).toContain("email = zedbee@example.invalid");
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
  });

  it("copies a prepared project into an independent repository", async () => {
    const template = await createGitRepository();
    await template.write("src/value.ts", "export const value = 1;\n");
    await template.commitAll("prepared project");

    const repository = await copyGitRepository(template.root);
    await repository.write("src/value.ts", "export const value = 2;\n");
    await repository.commitAll("copy change");

    expect(await template.read("src/value.ts")).toBe(
      "export const value = 1;\n",
    );
    expect(await repository.read("src/value.ts")).toBe(
      "export const value = 2;\n",
    );
    expect((await template.git(["rev-list", "--count", "HEAD"])).stdout).toBe(
      "1",
    );
    expect(
      (await repository.git(["rev-list", "--count", "HEAD"])).stdout,
    ).toBe("2");
  });
});
