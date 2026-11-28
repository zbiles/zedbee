import { createGitRepository } from "../helpers/git-repository.js";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  updateFromMetadata,
  fetchLatestMetadata,
} from "../../src/updates/metadata.js";
import { readUpdateCache, writeUpdateCache } from "../../src/updates/cache.js";
import {
  getUpdateNotice,
  renderUpdateNotice,
  updateCommand,
} from "../../src/updates/notification.js";
import { refreshUpdateCache } from "../../src/updates/worker.js";

const roots: string[] = [];
const now = 1_788_000_000_000;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "zedbee-updates-test-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
const metadata = {
  name: "zedbee",
  version: "0.2.0",
  engines: { node: ">=22.13.0" },
} as const;

describe("release metadata", () => {
  it("compares semantic versions rather than strings", () => {
    expect(
      updateFromMetadata({ ...metadata, version: "0.10.0" }, "0.9.0", "24.0.0"),
    ).toEqual({ current: "0.9.0", latest: "0.10.0" });
  });
  it.each([
    [metadata, "0.2.0", "24.0.0"],
    [metadata, "0.3.0", "24.0.0"],
    [metadata, "0.1.0", "20.0.0"],
    [{ ...metadata, version: "0.3.0-beta.1" }, "0.1.0", "24.0.0"],
    [{ ...metadata, name: "other" }, "0.1.0", "24.0.0"],
    [{ ...metadata, version: "0.2.0\nBAD" }, "0.1.0", "24.0.0"],
    [{ ...metadata, engines: { node: "bad range" } }, "0.1.0", "24.0.0"],
    [null, "0.1.0", "24.0.0"],
  ])(
    "ignores current, older, prerelease, incompatible and invalid releases",
    (value, current, node) => {
      expect(updateFromMetadata(value, current, node)).toBeUndefined();
    },
  );
  it("only requests public release metadata and rejects oversized responses", async () => {
    const requests: string[] = [];
    const result = await fetchLatestMetadata(async (url, options) => {
      requests.push(String(url));
      expect(options?.redirect).toBe("error");
      expect(options?.signal).toBeDefined();
      return new Response(JSON.stringify(metadata));
    });
    expect(requests).toEqual(["https://registry.npmjs.org/zedbee/latest"]);
    expect(result).toEqual(metadata);
    expect(
      await fetchLatestMetadata(async () => new Response("x".repeat(70_000))),
    ).toBeUndefined();
  });
  it.each([404, 429, 500])("quietly handles npm status %s", async (status) => {
    expect(
      await fetchLatestMetadata(async () => new Response("", { status })),
    ).toBeUndefined();
  });
  it("quietly handles offline and malformed responses", async () => {
    expect(
      await fetchLatestMetadata(async () => {
        throw new Error("offline");
      }),
    ).toBeUndefined();
    expect(
      await fetchLatestMetadata(async () => new Response("not json")),
    ).toBeUndefined();
  });
});

describe("cached CLI notification", () => {
  function setup() {
    const root = fixture();
    const cachePath = join(root, "zedbee", "update.json");
    writeUpdateCache(cachePath, { checkedAt: now, metadata });
    return {
      root,
      cachePath,
      options: {
        env: { XDG_CACHE_HOME: root },
        cwd: root,
        isTTY: true,
        format: "auto",
        currentVersion: "0.1.0",
        nodeVersion: "24.0.0",
        now,
      },
    };
  }
  it("uses a fresh cached notice without scheduling a network refresh", () => {
    const { options } = setup();
    let refreshes = 0;
    expect(
      getUpdateNotice({
        ...options,
        refresh: () => {
          refreshes++;
        },
      }),
    ).toEqual({ current: "0.1.0", latest: "0.2.0" });
    expect(refreshes).toBe(0);
  });
  it.each([
    { isTTY: false },
    { format: "json" },
    { format: "sarif" },
    { env: { CI: "1" } },
    { env: { ZEDBEE_NO_UPDATE_CHECK: "1" } },
    { env: { NO_UPDATE_NOTIFIER: "1" } },
  ])("suppresses both network and notice when disabled: %j", (override) => {
    const { options } = setup();
    let refreshes = 0;
    expect(
      getUpdateNotice({
        ...options,
        ...override,
        env: { ...options.env, ...("env" in override ? override.env : {}) },
        refresh: () => {
          refreshes++;
        },
      }),
    ).toBeUndefined();
    expect(refreshes).toBe(0);
  });
  it("refreshes stale state without letting launch failures affect the notice", () => {
    const { options } = setup();
    let refreshes = 0;
    const notice = getUpdateNotice({
      ...options,
      now: now + 2 * 86_400_000,
      refresh: () => {
        refreshes++;
        throw new Error("spawn unavailable");
      },
    });
    expect(refreshes).toBe(1);
    expect(notice?.latest).toBe("0.2.0");
  });
  it("treats corrupt and future cache records as misses", () => {
    const { cachePath } = setup();
    writeFileSync(cachePath, "bad json");
    expect(readUpdateCache(cachePath, now)).toBeUndefined();
    writeUpdateCache(cachePath, { checkedAt: now + 86_400_000, metadata });
    expect(readUpdateCache(cachePath, now)).toBeUndefined();
  });
  it("does not retain an update notice indefinitely", () => {
    const { options } = setup();
    expect(
      getUpdateNotice({
        ...options,
        now: now + 8 * 86_400_000,
        refresh: () => {},
      }),
    ).toBeUndefined();
  });
  it("keeps no-color output free of escape codes and shows the local update command", async () => {
    const { root } = await createGitRepository();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({ devDependencies: { zedbee: "^0.1.0" } }),
    );
    const text = await renderUpdateNotice(
      { current: "0.1.0", latest: "0.2.0" },
      { cwd: root, color: false },
    );
    expect(text).toContain("UPDATE AVAILABLE");
    expect(text).toContain("0.1.0 → 0.2.0");
    expect(text).toContain("npm install --save-dev zedbee@latest");
    expect(text).not.toContain("\u001b");
  });
  it.each([
    ["pnpm", "pnpm add --save-dev zedbee@latest"],
    ["yarn", "yarn add --dev zedbee@latest"],
    ["bun", "bun add --dev zedbee@latest"],
  ])("uses the project's %s declaration", async (manager, expected) => {
    const { root } = await createGitRepository();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        packageManager: `${manager}@1.0.0`,
        devDependencies: { zedbee: "^0.1.0" },
      }),
    );
    expect(await updateCommand(root)).toContain(expected);
  });
  it("permits pnpm's intentional workspace-root dev dependency update", async () => {
    const { root } = await createGitRepository();
    writeFileSync(
      join(root, "package.json"),
      JSON.stringify({
        packageManager: "pnpm@10.0.0",
        devDependencies: { zedbee: "^0.1.0" },
      }),
    );
    writeFileSync(
      join(root, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
    );
    expect(await updateCommand(root)).toContain(
      "pnpm add --save-dev --workspace-root zedbee@latest",
    );
  });
});

describe("background refresh", () => {
  it("persists real response metadata and reuses it on the next invocation", async () => {
    const root = fixture();
    const cachePath = join(root, "zedbee", "update.json");
    let requests = 0;
    const fetcher: typeof fetch = async () => {
      requests++;
      return new Response(JSON.stringify(metadata));
    };
    await refreshUpdateCache(cachePath, { now, fetcher });
    await refreshUpdateCache(cachePath, { now: now + 1000, fetcher });
    expect(readUpdateCache(cachePath, now + 1000)?.metadata).toEqual(metadata);
    expect(requests).toBe(1);
    expect(readFileSync(cachePath, "utf8")).not.toContain(root);
  });
  it("backs off after an unpublished-package response", async () => {
    const root = fixture();
    const cachePath = join(root, "zedbee", "update.json");
    await refreshUpdateCache(cachePath, {
      now,
      fetcher: async () => new Response("", { status: 404 }),
    });
    expect(readUpdateCache(cachePath, now)).toEqual({
      checkedAt: now,
      metadata: null,
    });
  });
  it("does not race concurrent refreshes into duplicate requests", async () => {
    const root = fixture();
    const cachePath = join(root, "zedbee", "update.json");
    let requests = 0;
    const fetcher: typeof fetch = async () => {
      requests++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return new Response(JSON.stringify(metadata));
    };
    await Promise.all([
      refreshUpdateCache(cachePath, { now, fetcher }),
      refreshUpdateCache(cachePath, { now, fetcher }),
    ]);
    expect(requests).toBe(1);
  });
});

it("keeps a delayed refresh's lease beyond the former expiration interval", async () => {
  const path = join(fixture(), "zedbee", "update.json");
  let started!: () => void, finish!: () => void;
  const held = new Promise<void>((resolve) => {
    started = resolve;
  });
  const response = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let competitors = 0;
  const old = refreshUpdateCache(path, {
    now,
    fetcher: async () => {
      started();
      await response;
      return new Response(JSON.stringify(metadata));
    },
  });
  await held;
  try {
    await refreshUpdateCache(path, {
      now: now + 31_000,
      fetcher: async () => {
        competitors++;
        return new Response(JSON.stringify({ ...metadata, version: "0.3.0" }));
      },
    });
    expect(competitors).toBe(0);
  } finally {
    finish();
    await old;
  }
  const later = now + 2 * 86400000;
  await refreshUpdateCache(path, {
    now: later,
    fetcher: async () =>
      new Response(JSON.stringify({ ...metadata, version: "0.3.0" })),
  });
  expect(readUpdateCache(path, later)?.metadata?.version).toBe("0.3.0");
});

it.skipIf(process.platform === "win32")(
  "treats a FIFO cache path as missing instead of blocking",
  () => {
    const directory = join(fixture(), "zedbee");
    mkdirSync(directory, { recursive: true });
    const cachePath = join(directory, "update.json");
    execFileSync("mkfifo", [cachePath]);
    expect(readUpdateCache(cachePath, now)).toBeUndefined();
  },
);

it("identifies nested pnpm declaration from repository root and subdirectories", async () => {
  const repo = await createGitRepository();
  await repo.write("package.json", '{"name":"root"}');
  await repo.write(
    "nested/package.json",
    '{"name":"nested","devDependencies":{"zedbee":"^0.1.0"}}',
  );
  await repo.write("nested/pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  await repo.write("nested/src/index.ts", "export {};\n");
  expect(await updateCommand(repo.root)).toContain(
    'directory "nested": pnpm add --save-dev zedbee@latest',
  );
  expect(await updateCommand(join(repo.root, "nested/src"))).toContain(
    'directory "nested": pnpm add --save-dev zedbee@latest',
  );
});
