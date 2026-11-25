import { expect, it } from "vitest";
import { createGitRepository } from "../helpers/git-repository.js";
import { runScan } from "../../src/scan/run-scan.js";
import { CHECK_IDS } from "../../src/config/schema.js";
import { renderJson } from "../../src/renderers/json.js";

it.each([
  ["redaction.py", "#"],
  ["redaction.js", "//"],
])(
  "supports a narrow synthetic fixture annotation in %s",
  async (path, comment) => {
    const repo = await createGitRepository();
    await repo.write(
      ".zedbeerc.jsonc",
      JSON.stringify({
        schemaVersion: 1,
        checks: Object.fromEntries(
          CHECK_IDS.map((id) => [id, id === "secrets" ? "error" : "off"]),
        ),
      }),
    );
    await repo.commitAll("baseline");
    // secretlint-disable-next-line @secretlint/secretlint-rule-database-connection-string -- Synthetic redaction fixture
    const url = "postgresql://fixture:fake_password@db.example.invalid/test";
    const annotation = `${comment} secretlint-disable-next-line @secretlint/secretlint-rule-database-connection-string -- Synthetic redaction fixture\n`;
    const line = path.endsWith(".py")
      ? `DATABASE_URL = "${url}"\n`
      : `const DATABASE_URL = "${url}";\n`;
    const scan = () => runScan({ repositoryRoot: repo.root, cache: false });
    await repo.write(path, line);
    await repo.git(["add", path]);
    const blocked = await scan();
    expect(blocked.outcome).toBe("blocked");
    expect(blocked.summary.findings[0]?.remediation).toContain("synthetic");
    expect(renderJson(blocked)).not.toContain("fake_password");
    await repo.write(path, annotation + line);
    await repo.git(["add", path]);
    expect((await scan()).outcome).toBe("pass");
    await repo.write(path, annotation + line + line);
    await repo.git(["add", path]);
    const adjacent = await scan();
    expect(adjacent.outcome).toBe("blocked");
    expect(adjacent.summary.findings).toHaveLength(1);
    expect(adjacent.summary.findings[0]?.location?.startLine).toBe(3);
    const token = `ghp_${"g".repeat(36)}`;
    await repo.write(
      path,
      annotation + line.trimEnd() + ` ${comment} ${token}\n`,
    );
    await repo.git(["add", path]);
    expect(
      (await scan()).summary.findings.some(
        (f) => f.rule === "@secretlint/secretlint-rule-github",
      ),
    ).toBe(true);
    const config = JSON.parse(await repo.read(".zedbeerc.jsonc"));
    config.pathExclusions = [
      { files: [path], checks: ["secrets"], reason: "Synthetic fixture" },
    ];
    await repo.write(".zedbeerc.jsonc", JSON.stringify(config));
    await repo.write("other.py", line);
    await repo.git(["add", "."]);
    const excluded = await scan();
    expect(excluded.summary.findings).toHaveLength(1);
    expect(excluded.summary.findings[0]?.location?.file).toBe("other.py");
  },
);
