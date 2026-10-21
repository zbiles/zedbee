import { describe, expect, it } from "vitest";
import { resolveConfig } from "../../src/config/profiles.js";
import { createFilePolicyResolver } from "../../src/config/file-policy.js";
import { dependencyArchitectureAdapter } from "../../src/checks/dependency-architecture/adapter.js";
import { dispatchChecks } from "../../src/checks/dispatcher.js";
import type { CheckObservationSet } from "../../src/checks/adapter.js";
import type { ObservationCache } from "../../src/cache/store.js";
import { GitClient } from "../../src/git/client.js";
import { readStagedChangeSet } from "../../src/git/change-set.js";
import { buildSnapshotPair } from "../../src/git/snapshot.js";
import { inspectRepository } from "../../src/inspection/inspect-repository.js";
import { createGitRepository } from "../helpers/git-repository.js";

describe("cached delta attribution", () => {
  it("recollects after a mode-only manifest delta and agrees with an uncached scan", async () => {
    const repo = await createGitRepository("zedbee-cache-delta-");
    await repo.write("package.json", '{"name":"probe","type":"module"}\n');
    await repo.write(
      "src/a.js",
      'import {b} from "./b.js"; export const a = b;\n',
    );
    await repo.write("src/b.js", "export const b = 1;\n");
    await repo.commitAll("base");
    await repo.write(
      "src/b.js",
      'import {a} from "./a.js"; export const b = a;\n',
    );
    expect((await repo.git(["add", "src/b.js"])).exitCode).toBe(0);

    const values = new Map<string, CheckObservationSet>();
    let hits = 0;
    const cache: ObservationCache = {
      get: async (key) => {
        const value = values.get(key);
        if (value !== undefined) hits += 1;
        return value;
      },
      set: async (key, value) => {
        values.set(key, value);
      },
    };
    const scan = async (useCache = true) => {
      const client = new GitClient(repo.root);
      const snapshots = await buildSnapshotPair(repo.root, client);
      try {
        const changeSet = await readStagedChangeSet(client);
        const [baselineInspection, targetInspection] = await Promise.all([
          inspectRepository(snapshots.baselineDir),
          inspectRepository(snapshots.targetDir),
        ]);
        const config = resolveConfig({ schemaVersion: 1, profile: "thorough" });
        const results = await dispatchChecks(
          [dependencyArchitectureAdapter],
          {
            repositoryRoot: repo.root,
            snapshots,
            changeSet,
            config,
            policyForFile: createFilePolicyResolver(config, changeSet),
            baselineInspection,
            targetInspection,
            signal: new AbortController().signal,
          },
          useCache ? { cache } : {},
        );
        return results.map(({ result }) => ({ ...result, durationMs: 0 }));
      } finally {
        await snapshots.cleanup();
      }
    };

    const before = await scan();
    expect(await scan()).toEqual(before);
    expect(hits).toBe(1);
    expect(
      (await repo.git(["update-index", "--chmod=+x", "package.json"])).exitCode,
    ).toBe(0);
    const cached = await scan();
    const uncached = await scan(false);
    expect(cached).toEqual(uncached);
    expect(hits).toBe(1);
    expect(await scan()).toEqual(uncached);
    expect(hits).toBe(2);
    expect(values.size).toBe(2);
  });
});
