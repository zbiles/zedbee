import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe.each(["index", "base"] as const)("%s secrets scans", (mode) => {
  it.each(["added", "binary-baseline", "binary-target"] as const)(
    "skips an oversized binary %s without making the check incomplete",
    async (kind) => {
      const repository = await createGitRepository("zedbee-binary-secrets-");
      await repository.write("package.json", '{"name":"binary-secrets"}');
      await repository.write(
        ".zedbeerc.jsonc",
        JSON.stringify({
          schemaVersion: 1,
          profile: "fast",
          checks: Object.fromEntries(
            CHECK_IDS.map((id) => [id, id === "secrets" ? "error" : "off"]),
          ),
        }),
      );
      const path = "public/images/asset.png";
      // Larger than both the 1 MiB secrets limit and the 8 MiB source capture.
      // Put the NUL at the end so this also covers binary classification beyond
      // a short prefix, independently of the file extension.
      const binary = Buffer.alloc(9 * 1024 * 1024, 0x61);
      binary[binary.length - 1] = 0;
      if (kind !== "added") {
        await repository.write(path, "safe text\n");
        if (kind === "binary-baseline")
          await writeFile(join(repository.root, path), binary);
      }
      await repository.commitAll("baseline");
      const baseline = (await repository.git(["rev-parse", "HEAD"])).stdout;
      await repository.write(
        path,
        kind === "binary-baseline"
          ? `token=ghp_${"g".repeat(36)}\n`
          : "safe text\n",
      );
      if (kind !== "binary-baseline")
        await writeFile(join(repository.root, path), binary);
      await repository.git(["add", "--all"]);
      if (mode === "base") await repository.commitAll("selected target");

      const report = await runScan({
        repositoryRoot: repository.root,
        ...(mode === "base" ? { baseRef: baseline } : {}),
      });
      expect(report).toMatchObject({
        mode,
        outcome: kind === "binary-baseline" ? "blocked" : "pass",
        exitCode: kind === "binary-baseline" ? 1 : 0,
      });
      const secrets = report.checks.find(
        (check) => check.checkId === "secrets",
      );
      expect(secrets?.status).toBe("completed");
      expect(secrets?.findings).toHaveLength(
        kind === "binary-baseline" ? 1 : 0,
      );
    },
  );

  it("still rejects oversized text disguised with an image extension", async () => {
    const repository = await createGitRepository("zedbee-text-secrets-");
    await repository.write("package.json", '{"name":"text-secrets"}');
    await repository.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        profile: "fast",
        checks: Object.fromEntries(
          CHECK_IDS.map((id) => [id, id === "secrets" ? "error" : "off"]),
        ),
      }),
    );
    await repository.commitAll("baseline");
    const baseline = (await repository.git(["rev-parse", "HEAD"])).stdout;
    await repository.write("asset.png", "x".repeat(1024 * 1024 + 1));
    await repository.git(["add", "--all"]);
    if (mode === "base") await repository.commitAll("selected target");
    const report = await runScan({
      repositoryRoot: repository.root,
      ...(mode === "base" ? { baseRef: baseline } : {}),
    });
    expect(report).toMatchObject({ outcome: "incomplete", exitCode: 2 });
    expect(
      report.checks.find((check) => check.checkId === "secrets"),
    ).toMatchObject({
      status: "incomplete",
      error: { code: "SECRET_FILE_TOO_LARGE", path: "asset.png" },
    });
  });
});
