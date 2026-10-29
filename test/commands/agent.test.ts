import { access, mkdir, readFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeAgentCommand } from "../../src/commands/agent.js";
import { createGitRepository } from "../helpers/git-repository.js";

async function run(cwd: string, install?: "codex" | "claude", yes = false) {
  const stdout: string[] = [],
    stderr: string[] = [];
  const code = await executeAgentCommand(
    { cwd, ...(install ? { install } : {}), yes },
    {
      writeStdout: (value) => stdout.push(value),
      writeStderr: (value) => stderr.push(value),
    },
  );
  return { code, stdout: stdout.join(""), stderr: stderr.join("") };
}
const source = new URL(
  "../../plugins/swarm/references/scan.md",
  import.meta.url,
);

describe("agent workflow", () => {
  it("prints the packaged source verbatim without requiring a repository", async () => {
    const result = await run("/no-such-repository");
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toBe(
      (await readFile(source, "utf8")).replace(
        /^name: scan$/mu,
        "name: zedbee",
      ),
    );
  });
  it.each(["codex", "claude"] as const)(
    "previews and installs for %s from a nested directory without touching the index",
    async (install) => {
      const repo = await createGitRepository("zedbee-agent-");
      await repo.write("staged.txt", "staged\n");
      await repo.git(["add", "staged.txt"]);
      await repo.write("staged.txt", "unstaged\n");
      const before = await repo.git(["write-tree"]);
      const directory = install === "codex" ? ".agents" : ".claude";
      const destination = join(repo.root, directory, "skills/zedbee/SKILL.md");
      await mkdir(join(repo.root, "nested"));
      const preview = await run(join(repo.root, "nested"), install);
      expect(preview.code, preview.stderr).toBe(0);
      expect(preview.stdout).toContain(`${directory}/skills/zedbee/SKILL.md`);
      await expect(access(destination)).rejects.toThrow();
      const result = await run(join(repo.root, "nested"), install, true);
      expect(result.code, result.stderr).toBe(0);
      expect(await readFile(destination, "utf8")).toBe(
        (await readFile(source, "utf8")).replace(
          /^name: scan$/mu,
          "name: zedbee",
        ),
      );
      expect((await repo.git(["write-tree"])).stdout).toBe(before.stdout);
      expect(await repo.read("staged.txt")).toBe("unstaged\n");
      expect((await run(repo.root, install, true)).code).toBe(0);
    },
  );
  it("preserves customized skill files and reports a conflict", async () => {
    const repo = await createGitRepository();
    await repo.write(".agents/skills/zedbee/SKILL.md", "custom instructions\n");
    const result = await run(repo.root, "codex", true);
    expect(result.code).toBe(1);
    expect(await repo.read(".agents/skills/zedbee/SKILL.md")).toBe(
      "custom instructions\n",
    );
    expect(result.stderr).toContain("preserved");
  });
  it.each([
    ".agents",
    ".agents/skills",
    ".agents/skills/zedbee",
    ".agents/skills/zedbee/SKILL.md",
  ])("rejects symlink destinations at %s", async (path) => {
    const repo = await createGitRepository();
    const outside = await createGitRepository();
    await outside.write("original", "keep\n");
    const destination = join(repo.root, path);
    await mkdir(join(destination, ".."), { recursive: true });
    await symlink(
      path.endsWith(".md") ? join(outside.root, "original") : outside.root,
      destination,
      path.endsWith(".md") ? "file" : "dir",
    );
    expect((await run(repo.root, "codex", true)).code).toBe(2);
    expect(await outside.read("original")).toBe("keep\n");
    await expect(
      access(join(outside.root, "skills/zedbee/SKILL.md")),
    ).rejects.toThrow();
  });
  it("rejects a file in the destination ancestry", async () => {
    const repo = await createGitRepository();
    await repo.write(".claude", "keep");
    expect((await run(repo.root, "claude", true)).code).toBe(2);
    expect(await repo.read(".claude")).toBe("keep");
  });
  it("requires a Git repository for installation", async () => {
    expect((await run("/no-such-repository", "codex", true)).code).toBe(2);
  });
});
