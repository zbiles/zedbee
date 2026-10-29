import { symlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runScan } from "../../src/scan/run-scan.js";
import { CHECK_IDS } from "../../src/config/schema.js";
import { createGitRepository } from "../helpers/git-repository.js";

async function fixture() {
  const repo = await createGitRepository("zedbee-link-policy-");
  await repo.write("web/package.json", '{"name":"web"}');
  await repo.write(
    "web/tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        strict: true,
        types: [],
        resolveJsonModule: true,
        esModuleInterop: true,
      },
      include: ["*.ts"],
    }),
  );
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "recommended",
      checks: Object.fromEntries(
        CHECK_IDS.map((id) => [
          id,
          id === "types" || id === "secrets" ? "error" : "off",
        ]),
      ),
    }),
  );
  await repo.write("web/data.json", '{"value":1}');
  await repo.write(
    "web/consumer.ts",
    'import data from "./data.json";\nexport const value: number = data.value;\n',
  );
  await repo.write("web/debt.ts", 'export const debt: number = "old";\n');
  await mkdir(join(repo.root, "research/runtime"), { recursive: true });
  await symlink(
    "missing-runtime-lock",
    join(repo.root, "research/runtime/SingletonLock"),
    "file",
  );
  await repo.commitAll("existing independent project and runtime link");
  return repo;
}

describe("snapshot link scan policy", () => {
  it.each([false, true])(
    "preserves attribution with an unrelated existing link (new break: %s)",
    async (broken) => {
      const repo = await fixture();
      await repo.write(
        "web/data.json",
        broken ? '{"value":"new break"}' : '{"value":2}',
      );
      await repo.git(["add", "web/data.json"]);
      const report = await runScan({ repositoryRoot: repo.root });
      expect(report.outcome, JSON.stringify(report)).toBe(
        broken ? "blocked" : "pass",
      );
      expect(
        report.checks.some(
          (c) => c.checkId === "types" && c.status === "completed",
        ),
      ).toBe(true);
      expect(
        report.checks.some(
          (c) => c.checkId === "secrets" && c.status === "completed",
        ),
      ).toBe(true);
      expect(
        report.summary.findings.some((f) => f.location?.file === "web/debt.ts"),
      ).toBe(false);
      if (broken)
        expect(report.summary.findings).toContainEqual(
          expect.objectContaining({
            location: expect.objectContaining({ file: "web/consumer.ts" }),
          }),
        );
    },
  );
  it.each(["dangling", "external"])(
    "reports safe diagnostics for a required %s source link",
    async (kind) => {
      const repo = await fixture();
      const path = "web/alias.ts";
      const outside = await createGitRepository("zedbee-link-outside-");
      await outside.write(
        "outside-private-location.ts",
        "outside contents must never be read",
      );
      const target =
        kind === "external"
          ? join(outside.root, "outside-private-location.ts")
          : "missing-source";
      await symlink(target, join(repo.root, path), "file");
      await repo.git(["add", path]);
      const report = await runScan({ repositoryRoot: repo.root, cache: false });
      expect(report.outcome).toBe("incomplete");
      expect(report.checks[0]?.error).toMatchObject({
        code: "TARGET_INSPECTION_FAILED",
        path,
      });
      expect(report.checks[0]?.error?.message).toMatch(/symbolic link/u);
      expect(JSON.stringify(report.checks)).not.toContain(
        "outside-private-location",
      );
      expect(JSON.stringify(report.checks)).not.toContain(repo.root);
    },
  );
});

describe("new runtime link diagnostics", () => {
  it("identifies a newly staged unavailable link required by secrets", async () => {
    const repo = await fixture();
    const path = "research/runtime/new-lock";
    await symlink("missing-new-lock", join(repo.root, path), "file");
    await repo.git(["add", path]);
    const report = await runScan({ repositoryRoot: repo.root, cache: false });
    expect(report.outcome).toBe("incomplete");
    expect(
      report.checks.find((check) => check.checkId === "secrets")?.error,
    ).toMatchObject({ code: "SECRET_FILE_UNSAFE", path });
    expect(
      report.checks.some(
        (check) => check.error?.code === "TARGET_INSPECTION_FAILED",
      ),
    ).toBe(false);
  });
});
