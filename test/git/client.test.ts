import { realpath } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { GitClient } from "../../src/git/client.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("GitClient", () => {
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
    await repository.git(["config", "alias.zedbee-wait", "!sleep 1"]);
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
            () => reject(new Error("Git hard timeout did not cancel the process.")),
            250,
          );
        }),
      ]),
    ).rejects.toMatchObject({ code: "GIT_HARD_TIMEOUT" });
  });
});
