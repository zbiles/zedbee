import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireServiceExecutor,
  stopService,
} from "../../src/service/client.js";
import { ObservationCacheStore } from "../../src/cache/store.js";
import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";
import { runScan } from "../../src/scan/run-scan.js";
import { createGitRepository } from "../helpers/git-repository.js";

const rule = "react-hooks/set-state-in-effect";
function source(timing: "before" | "after", wrapper: boolean) {
  return `import { useCallback, useEffect, useState } from "react";
export function useExample() {
  const [value, setValue] = useState(0);
  const read = useCallback(async () => {
    ${timing === "before" ? "setValue(1);" : ""}
    await Promise.resolve();
    ${timing === "after" ? "setValue(1);" : ""}
  }, []);
  useEffect(() => {
    ${wrapper ? "void (async () => { await read(); })();" : "void read().then(() => {});"}
  }, [read]);
  return value;
}
`;
}
async function fixture(
  severity: "off" | "warn" | "error" = "error",
  baseline?: string,
) {
  const repo = await createGitRepository("zedbee-effect-timing-");
  await repo.write(
    "package.json",
    JSON.stringify({
      name: "effect-fixture",
      private: true,
      dependencies: { react: "19.0.0" },
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
          id === "reactCorrectness"
            ? { severity: "error", rules: { [rule]: severity } }
            : "off",
        ]),
      ),
    }),
  );
  await repo.write(
    "src/example.tsx",
    baseline ?? "export function useExample() { return 0; }\n",
  );
  await repo.commitAll("baseline");
  return repo;
}

describe("effect timing in staged commit scans", () => {
  it.each([false, true])(
    "allows post-wait updates (wrapper=%s)",
    async (wrapper) => {
      const repo = await fixture();
      await repo.write("src/example.tsx", source("after", wrapper));
      await repo.git(["add", "src/example.tsx"]);
      const report = await runScan({ repositoryRoot: repo.root, cache: false });
      expect(
        report.checks.every((check) => check.status === "completed"),
        JSON.stringify(report.checks),
      ).toBe(true);
      expect(report.summary.findings.filter((f) => f.rule === rule)).toEqual(
        [],
      );
      expect(report.outcome).toBe("pass");
    },
  );

  it.each([false, true])(
    "blocks new immediate updates (wrapper=%s)",
    async (wrapper) => {
      const repo = await fixture();
      await repo.write("src/example.tsx", source("before", wrapper));
      await repo.git(["add", "src/example.tsx"]);
      const report = await runScan({ repositoryRoot: repo.root, cache: false });
      expect(report.outcome, JSON.stringify(report)).toBe("blocked");
      expect(report.summary.findings).toContainEqual(
        expect.objectContaining({
          rule,
          severity: "error",
          attribution: expect.objectContaining({ staged: true }),
        }),
      );
    },
  );

  it("allows equivalent post-wait rewrites", async () => {
    const repo = await fixture("error", source("after", false));
    await repo.write("src/example.tsx", source("after", true));
    await repo.git(["add", "src/example.tsx"]);
    const report = await runScan({ repositoryRoot: repo.root, cache: false });
    expect(report.outcome, JSON.stringify(report)).toBe("pass");
  });

  it("recognizes existing immediate-update debt after a line shift", async () => {
    const repo = await fixture("error", source("before", true));
    await repo.write(
      "src/example.tsx",
      "// unrelated comment\n" + source("before", true),
    );
    await repo.git(["add", "src/example.tsx"]);
    const report = await runScan({ repositoryRoot: repo.root, cache: false });
    expect(report.outcome, JSON.stringify(report)).toBe("pass");
    expect(
      report.summary.findings.filter(
        (f) => f.rule === rule && f.attribution.staged,
      ),
    ).toEqual([]);
  });

  it.each(["off", "warn"] as const)(
    "honors %s rule overrides",
    async (severity) => {
      const repo = await fixture(severity);
      await repo.write("src/example.tsx", source("before", true));
      await repo.git(["add", "src/example.tsx"]);
      const report = await runScan({ repositoryRoot: repo.root, cache: false });
      expect(report.outcome, JSON.stringify(report)).toBe("pass");
      const findings = report.summary.findings.filter((f) => f.rule === rule);
      if (severity === "off") expect(findings).toEqual([]);
      else
        expect(findings).toContainEqual(
          expect.objectContaining({ severity: "warning" }),
        );
    },
  );
});

it("uses corrected results in the shared analyzer service and warm cache", async () => {
  const repo = await fixture();
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "zt-effect-")));
  const options = { directory: join(scratch, "s"), concurrency: 1 as const };
  const cache = new ObservationCacheStore({ root: join(scratch, "cache") });
  const executor = await acquireServiceExecutor(options);
  try {
    for (const timing of ["after", "before"] as const) {
      await repo.write("src/example.tsx", source(timing, true));
      await repo.git(["add", "src/example.tsx"]);
      for (let attempt = 0; attempt < 2; attempt++) {
        const report = await runScan({
          repositoryRoot: repo.root,
          cache,
          executor,
        });
        expect(report.outcome, JSON.stringify(report)).toBe(
          timing === "after" ? "pass" : "blocked",
        );
      }
    }
  } finally {
    await executor.close();
    await stopService(options);
    await rm(scratch, { recursive: true, force: true });
  }
});
