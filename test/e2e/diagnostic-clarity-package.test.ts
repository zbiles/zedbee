import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { createGitRepository } from "../helpers/git-repository.js";
import {
  installPackedFixture,
  sharedPackedTarball,
} from "../helpers/packed-install.js";

it("renders contextual and source-free diagnostics from the installed package", async () => {
  const repo = await createGitRepository("zedbee-diagnostic-package-");
  const scratch = await mkdtemp(join(tmpdir(), "zedbee-diagnostic-pack-"));
  const root = resolve(import.meta.dirname, "../..");
  try {
    await repo.write(
      "package.json",
      JSON.stringify({ name: "consumer", type: "module", private: true }),
    );
    await repo.write(
      "tsconfig.json",
      JSON.stringify({
        compilerOptions: {
          strict: true,
          noEmit: true,
          types: [],
          module: "ESNext",
          moduleResolution: "bundler",
        },
        include: ["src/**/*.ts"],
      }),
    );
    await repo.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        checks: Object.fromEntries(
          CHECK_IDS.map((id) => [id, id === "types" ? "error" : "off"]),
        ),
      }),
    );
    await repo.write("src/account.ts", "export const existing = 1;\n");
    await repo.write("src/index.ts", "export const value = 1;\n");
    await repo.commitAll("baseline");
    let tarball = sharedPackedTarball()?.path;
    if (!tarball) {
      const result = await execa(
        "npm",
        [
          "pack",
          root,
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          scratch,
        ],
        { env: { npm_config_cache: join(scratch, "pack-cache") } },
      );
      tarball = join(scratch, JSON.parse(result.stdout)[0].filename);
    }
    await installPackedFixture(
      tarball!,
      root,
      repo.root,
      join(scratch, "cache"),
    );
    await repo.write(
      "src/index.ts",
      'import { MissingAccount } from "./account";\nexport const current = MissingAccount;\n',
    );
    await repo.git(["add", "src/index.ts"]);
    const cli = join(repo.root, "node_modules/zedbee/dist/cli.js");
    const invoke = (format: string, policy: string) =>
      execa(
        process.execPath,
        [
          cli,
          "scan",
          "--format",
          format,
          "--no-service",
          "--no-source",
          "--diagnostic-messages",
          policy,
        ],
        {
          cwd: repo.root,
          reject: false,
          env: { ZEDBEE_TELEMETRY_DISABLED: "1" },
        },
      );
    const detailed = await invoke("json", "contextual");
    expect(detailed.exitCode, detailed.stderr).toBe(1);
    expect(
      JSON.parse(detailed.stdout).checks.flatMap(
        (check: { findings: unknown[] }) => check.findings,
      ),
    ).toContainEqual(
      expect.objectContaining({
        rule: "typescript/TS2305",
        message: expect.stringContaining("MissingAccount"),
      }),
    );
    const strict = await invoke("json", "source-free");
    expect(strict.exitCode, strict.stderr).toBe(1);
    expect(strict.stdout).not.toContain("MissingAccount");
    const text = await invoke("text", "contextual");
    expect(text.exitCode, text.stderr).toBe(1);
    expect(text.stdout).toContain("MissingAccount");
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
