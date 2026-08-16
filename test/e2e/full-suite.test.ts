import { describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { execa } from "execa";
import {
  releaseArtifactSteps,
  releaseReadiness,
  verificationSteps,
} from "../../scripts/release-check.mjs";

const root = resolve(import.meta.dirname, "../..");

describe("release verification contract", () => {
  it("runs every local release-safety gate without requiring publication metadata", () => {
    expect(verificationSteps("verify").map(({ id }) => id)).toEqual([
      "typecheck",
      "tests",
      "build",
      "schema",
      "licenses",
      "managed-binaries",
      "benchmark",
      "package",
      "documentation",
      "diff",
    ]);
  });

  it("makes real managed assets and platform package inspection release-only gates", () => {
    expect(
      releaseArtifactSteps().map(({ id, args }) => ({ id, args })),
    ).toEqual([
      {
        id: "managed-platform-assets",
        args: ["scripts/verify-managed-binaries.mjs"],
      },
      {
        id: "managed-platform-packages",
        args: ["scripts/check-package-contents.mjs", "--platforms"],
      },
    ]);
  });

  it("blocks release with the exact owner action when canonical metadata is absent", () => {
    expect(releaseReadiness({ name: "zedbee", version: "0.0.0" }, [])).toEqual({
      ready: false,
      message:
        "Release blocked: add the canonical HTTPS repository.url, homepage, and bugs.url to package.json and configure the matching Git remote.",
    });
  });

  it("accepts HTTPS metadata only when it identifies a configured Git remote", () => {
    expect(
      releaseReadiness(
        {
          repository: { url: "https://github.com/owner/zedbee.git" },
          homepage: "https://github.com/owner/zedbee#readme",
          bugs: { url: "https://github.com/owner/zedbee/issues" },
        },
        ["git@github.com:owner/zedbee.git"],
      ),
    ).toEqual({ ready: true });
  });

  it.each([
    {
      repository: "https://github.com/owner/zedbee.evil",
      homepage: "https://github.com/owner/zedbee.evil#readme",
      bugs: "https://github.com/owner/zedbee.evil/issues",
      remote: "git@github.com:owner/zedbee.git",
    },
    {
      repository: "https://github.com/owner/zedbee",
      homepage: "https://github.com.evil/owner/zedbee#readme",
      bugs: "https://github.com/owner/zedbee/issues",
      remote: "git@github.com:owner/zedbee.git",
    },
    {
      repository: "https://github.com/owner/zedbee",
      homepage: "https://github.com/owner/zedbee.evil#readme",
      bugs: "https://github.com/owner/zedbee/issues",
      remote: "git@github.com:owner/zedbee.git",
    },
    {
      repository: "https://github.com/owner/zedbee",
      homepage: "https://github.com/owner/zedbee#readme",
      bugs: "https://github.com/owner/zedbee-security",
      remote: "git@github.com:owner/zedbee.git",
    },
  ])(
    "rejects repository siblings and lookalike origins: $homepage",
    ({ repository, homepage, bugs, remote }) => {
      expect(
        releaseReadiness(
          {
            repository: { url: repository },
            homepage,
            bugs: { url: bugs },
          },
          [remote],
        ),
      ).toMatchObject({ ready: false });
    },
  );

  it("packs and inspects the core package without requiring downloaded platform assets", async () => {
    const result = await execa(
      process.execPath,
      [resolve(root, "scripts/check-package-contents.mjs")],
      { cwd: root, reject: false, stdin: "ignore" },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toBe("Core package contents passed.");
  }, 30_000);
});
