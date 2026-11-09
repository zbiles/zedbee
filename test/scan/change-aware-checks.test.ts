import { describe, expect, it } from "vitest";
import type { ScanEvent } from "../../src/checks/events.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";
import type { ProfileId } from "../../src/config/schema.js";

async function fixture(profile: ProfileId) {
  const repo = await createGitRepository("zedbee-change-aware-");
  await repo.write(
    "package.json",
    JSON.stringify({
      name: "synthetic",
      private: true,
      dependencies: { react: "19.0.0", "react-dom": "19.0.0" },
    }) + "\n",
  );
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({ schemaVersion: 1, profile }) + "\n",
  );
  await repo.write(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { strict: true, types: [] },
      include: ["src"],
    }) + "\n",
  );
  await repo.write("src/index.ts", "export const value = 1;\n");
  await repo.write("README.md", "# Notes\n\nOriginal.\n");
  await repo.write("script.py", "print('original')\n");
  await repo.write(".gitignore", "node_modules\n");
  await repo.commitAll("base");
  return repo;
}

const cases = [
  ["Python edit", "python"],
  ["Git ignore edit and Markdown untracking", "ignore-doc"],
  ["Markdown deletion", "delete-doc"],
  ["Markdown edit", "edit-doc"],
] as const;

describe.each(["fast", "recommended", "thorough"] as const)(
  "%s change-aware check jobs",
  (profile) => {
    it.each(cases)(
      "selects actual consumers for %s",
      async (_label, scenario) => {
        const repo = await fixture(profile);
        if (scenario === "python") {
          await repo.write("script.py", "print('updated')\n");
          expect((await repo.git(["add", "script.py"])).exitCode).toBe(0);
        } else if (scenario === "ignore-doc") {
          await repo.write(".gitignore", "node_modules\nREADME.md\n");
          expect(
            (await repo.git(["rm", "--cached", "README.md"])).exitCode,
          ).toBe(0);
          expect((await repo.git(["add", ".gitignore"])).exitCode).toBe(0);
        } else if (scenario === "delete-doc") {
          expect((await repo.git(["rm", "README.md"])).exitCode).toBe(0);
        } else {
          await repo.write("README.md", "# Notes\n\nUpdated.\n");
          expect((await repo.git(["add", "README.md"])).exitCode).toBe(0);
        }
        const events: ScanEvent[] = [];
        const report = await runScan({
          repositoryRoot: repo.root,
          cache: false,
          sourceExcerpts: "exclude",
          onEvent: (event) => events.push(event),
        });
        expect(report.outcome, JSON.stringify(report)).toBe("pass");
        const expected = [
          ...(scenario === "edit-doc" ? ["formatting"] : []),
          ...(profile !== "fast" && scenario !== "delete-doc"
            ? ["secrets"]
            : []),
        ].sort();
        expect(
          events
            .filter((event) => event.type === "check-running")
            .map((event) => event.checkId)
            .sort(),
        ).toEqual(expected);
        expect(
          events
            .filter((event) => event.type === "check-queued")
            .map((event) => event.checkId)
            .sort(),
        ).toEqual(expected);
      },
    );
  },
);

describe("language-independent secret scheduling", () => {
  it.each(["script.py", "README.md", ".gitignore"])(
    "still blocks a newly introduced secret in %s",
    async (path) => {
      const repo = await fixture("recommended");
      const syntheticToken = `ghp_${"A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8"}`;
      await repo.write(path, `# Synthetic fixture\n\n${syntheticToken}\n`);
      expect((await repo.git(["add", path])).exitCode).toBe(0);
      const events: ScanEvent[] = [];
      const report = await runScan({
        repositoryRoot: repo.root,
        cache: false,
        sourceExcerpts: "exclude",
        onEvent: (event) => events.push(event),
      });
      expect(report.outcome).toBe("blocked");
      expect(report.summary.findings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            check: "secrets",
            location: expect.objectContaining({ file: path }),
          }),
        ]),
      );
      expect(
        events.some(
          (event) =>
            event.type === "check-running" && event.checkId === "secrets",
        ),
      ).toBe(true);
      expect(JSON.stringify([report, events])).not.toContain(syntheticToken);
    },
  );
});

describe("check exclusions", () => {
  it("queues no secrets job when every changed target is excluded", async () => {
    const repo = await fixture("recommended");
    await repo.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        profile: "recommended",
        pathExclusions: [
          {
            files: ["script.py"],
            checks: ["secrets"],
            reason: "Synthetic excluded input",
          },
        ],
      }),
    );
    await repo.commitAll("exclude synthetic input");
    await repo.write("script.py", "print('updated')\n");
    expect((await repo.git(["add", "script.py"])).exitCode).toBe(0);
    const events: ScanEvent[] = [];
    const report = await runScan({
      repositoryRoot: repo.root,
      cache: false,
      sourceExcerpts: "exclude",
      onEvent: (event) => events.push(event),
    });
    expect(report.outcome).toBe("pass");
    expect(events.filter((event) => event.type === "check-running")).toEqual(
      [],
    );
  });
});
