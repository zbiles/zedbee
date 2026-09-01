import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { describe, expect, it } from "vitest";
import { GitClient } from "../../src/git/client.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("GitClient", () => {
  it.runIf(process.platform !== "win32")(
    "does not execute a project dependency named git",
    async () => {
      const repository = await createGitRepository();
      const binDirectory = join(repository.root, "node_modules", ".bin");
      const marker = join(repository.root, "FAKE_GIT_EXECUTED");
      const fakeGit = join(binDirectory, "git");
      await mkdir(binDirectory, { recursive: true });
      await writeFile(
        fakeGit,
        `#!/bin/sh\nprintf executed > '${marker}'\nprintf 'fake-git\\n'\n`,
      );
      await chmod(fakeGit, 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = `${binDirectory}${delimiter}${originalPath ?? ""}`;

      try {
        const output = await new GitClient(repository.root).run(["--version"]);

        expect(output.stdout).toMatch(/^git version /u);
        await expect(realpath(marker)).rejects.toThrow();
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not trust another repository directory when invoked from a nested path",
    async () => {
      const repository = await createGitRepository();
      const nestedDirectory = join(repository.root, "packages", "app");
      const binDirectory = join(repository.root, "tools");
      const marker = join(repository.root, "NESTED_FAKE_GIT_EXECUTED");
      const fakeGit = join(binDirectory, "git");
      await mkdir(nestedDirectory, { recursive: true });
      await mkdir(binDirectory, { recursive: true });
      await writeFile(
        fakeGit,
        `#!/bin/sh\nprintf executed > '${marker}'\nprintf 'nested-fake-git\\n'\n`,
      );
      await chmod(fakeGit, 0o755);
      const originalPath = process.env.PATH;
      process.env.PATH = `${binDirectory}${delimiter}${originalPath ?? ""}`;

      try {
        const output = await new GitClient(nestedDirectory).run(["--version"]);

        expect(output.stdout).toMatch(/^git version /u);
        await expect(realpath(marker)).rejects.toThrow();
      } finally {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
    },
  );

  it("passes filename arguments literally and returns NUL-delimited stdout", async () => {
    const repository = await createGitRepository();
    const filename = "odd ; $(name).ts";
    await repository.write(filename, "export const value = 1;\n");
    await repository.git(["add", "--", filename]);

    const client = new GitClient(repository.root);
    const output = await client.run(["diff", "--cached", "--name-only", "-z"]);

    expect(output).toEqual({
      stdout: `${filename}\0`,
      stderr: "",
      exitCode: 0,
    });
  });

  it.runIf(process.platform !== "win32")(
    "forces no-lazy-fetch while preserving an alternate index override",
    async () => {
      const repository = await createGitRepository();
      const alternateIndex = join(repository.root, "alternate-index");
      await repository.git([
        "config",
        "alias.zedbee-environment",
        '!f() { printf \'%s|%s\' "$GIT_NO_LAZY_FETCH" "$GIT_INDEX_FILE"; }; f',
      ]);

      const output = await new GitClient(repository.root).run(
        ["zedbee-environment"],
        {
          env: {
            GIT_NO_LAZY_FETCH: "0",
            GIT_INDEX_FILE: alternateIndex,
          },
        },
      );

      expect(output.stdout).toBe(`1|${alternateIndex}`);
    },
  );

  it("returns non-zero results through tryRun", async () => {
    const repository = await createGitRepository();
    const client = new GitClient(repository.root);

    const output = await client.tryRun([
      "rev-parse",
      "--verify",
      "missing-ref",
    ]);

    expect(output.exitCode).not.toBe(0);
    expect(output.stdout).toBe("");
  });

  it("sanitizes non-zero command failures", async () => {
    const repository = await createGitRepository();
    const client = new GitClient(repository.root);

    const error = await client
      .run(["rev-parse", "--verify", "secret-ref-name"])
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      name: "GitCommandError",
      code: "GIT_COMMAND_FAILED",
      exitCode: 128,
    });
    expect(String(error)).not.toContain("secret-ref-name");
    expect(String(error)).not.toContain(repository.root);
  });

  it("runs in repository paths containing spaces", async () => {
    const repository = await createGitRepository("zedbee test repo-");
    const client = new GitClient(repository.root);

    const output = await client.run(["rev-parse", "--show-toplevel"]);

    expect(output.stdout).toBe(await realpath(repository.root));
  });

  it("reports cancellation without running the command", async () => {
    const repository = await createGitRepository();
    const controller = new AbortController();
    controller.abort();
    const client = new GitClient(repository.root);

    const error = await client
      .run(["status"], { signal: controller.signal })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      name: "GitCommandError",
      code: "GIT_ABORTED",
    });
  });

  it("forwards a configured hard-timeout signal to a real Git invocation", async () => {
    const repository = await createGitRepository();
    await repository.git(["config", "alias.zedbee-wait", "!exec sleep 1"]);
    const client = new GitClient(repository.root, {
      resourcePolicy: {
        gitSoftTimeoutMs: undefined,
        gitHardTimeoutMs: 25,
        gitOutputLimitBytes: 1024,
      },
    });

    await expect(
      Promise.race([
        client.run(["zedbee-wait"]),
        new Promise<never>((_resolve, reject) => {
          setTimeout(
            () =>
              reject(new Error("Git hard timeout did not cancel the process.")),
            1_000,
          );
        }),
      ]),
    ).rejects.toMatchObject({ code: "GIT_HARD_TIMEOUT" });
  });

  it("maps a real Git output buffer breach to a sanitized error", async () => {
    const repository = await createGitRepository();
    await repository.write("value.ts", "export const value = true;\n");
    await repository.commitAll(
      "Git output buffer limit exceeded by this message",
    );
    const client = new GitClient(repository.root);

    const error = await client
      .run(["log", "--format=%B"], { maxOutputBytes: 8 })
      .catch((reason: unknown) => reason);

    expect(error).toMatchObject({
      name: "GitCommandError",
      code: "GIT_OUTPUT_LIMIT_EXCEEDED",
    });
    expect(String(error)).not.toContain(repository.root);
  });
});
