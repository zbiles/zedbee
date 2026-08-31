import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { expect, it } from "vitest";

it("finishes a bounded background refresh after the invoking CLI process exits", async () => {
  const root = await mkdtemp(join(tmpdir(), "zedbee-background-update-"));
  try {
    const preload = join(root, "registry-fixture.mjs");
    await writeFile(
      preload,
      `
      globalThis.fetch = async (url) => {
        if (url !== "https://registry.npmjs.org/zedbee/latest") throw new Error("Unexpected endpoint");
        return new Response(JSON.stringify({ name: "zedbee", version: "0.2.0", engines: { node: ">=22" } }));
      };
    `,
    );
    const notification = new URL(
      "../../dist/updates/notification.js",
      import.meta.url,
    ).href;
    const script = `
      import { getUpdateNotice } from ${JSON.stringify(notification)};
      delete process.env.CI;
      delete process.env.NO_UPDATE_NOTIFIER;
      delete process.env.ZEDBEE_NO_UPDATE_CHECK;
      const notice = getUpdateNotice({ env: process.env, isTTY: true, format: "auto", currentVersion: "0.1.0", nodeVersion: process.versions.node });
      if (notice !== undefined) process.exit(1);
      process.exit(0);
    `;
    const result = await execa(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        env: {
          XDG_CACHE_HOME: root,
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        },
        timeout: 3000,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    await expect
      .poll(
        async () => {
          try {
            return JSON.parse(
              await readFile(join(root, "zedbee", "update.json"), "utf8"),
            ).metadata;
          } catch {
            return undefined;
          }
        },
        { timeout: 4000, interval: 50 },
      )
      .toEqual({ name: "zedbee", version: "0.2.0", engines: { node: ">=22" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 10_000);
