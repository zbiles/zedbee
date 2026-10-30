import { expect, it } from "vitest";
import { Worker } from "node:worker_threads";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

it("loads the source identity worker without reading the repository tsconfig", async () => {
  const root = await mkdtemp(join(tmpdir(), "zedbee-source-identity-"));
  let worker: Worker | undefined;
  try {
    await mkdir(join(root, "dist"));
    await writeFile(join(root, "package.json"), '{"name":"fixture"}');
    const config = join(root, "tsconfig.json");
    await writeFile(config, '{"compilerOptions":{"strict":true}}');
    const entry = new URL(
      "../../src/service/identity-source-worker.mjs",
      import.meta.url,
    ).href;
    // Instrument inside the worker, before its loader imports filesystem bindings.
    worker = new Worker(
      `
      const fs = require("node:fs");
      const { parentPort } = require("node:worker_threads");
      const { fileURLToPath } = require("node:url");
      const original = fs.readFileSync;
      fs.readFileSync = function(file, ...args) {
        const path = file instanceof URL ? fileURLToPath(file) : String(file);
        if (path === ${JSON.stringify(config)}) parentPort.postMessage("repository-config-read");
        return original.call(this, file, ...args);
      };
      require("node:module").syncBuiltinESMExports();
      import(${JSON.stringify(entry)}).catch(error => { throw error; });
    `,
      {
        eval: true,
        execArgv: [],
        env: { ...process.env, TSX_TSCONFIG_PATH: config },
        workerData: { root, tree: "dist" },
      },
    );
    const messages: unknown[] = [];
    worker.on("message", (value) => messages.push(value));
    const code = await new Promise<number>((resolve, reject) => {
      worker!.once("exit", resolve);
      worker!.once("error", reject);
    });
    expect(code).toBe(0);
    expect(messages).toEqual([expect.stringMatching(/^[a-f0-9]{64}$/)]);
  } finally {
    await worker?.terminate();
    await rm(root, { recursive: true, force: true });
  }
});
