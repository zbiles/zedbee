import { Worker } from "node:worker_threads";
import { realpath } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createInspectionFixture } from "../../inspection/fixture.js";

describe("captured WASI resolver path namespace", () => {
  it("keeps real resolver filesystem operations POSIX when the WASI shim detects Windows", async () => {
    const fixture = await createInspectionFixture();
    await fixture.writeJson("package.json", {
      name: "virtual-path-fixture",
      imports: { "#local": "./src/lib.ts" },
    });
    await fixture.write("src/index.ts", 'import { used } from "./lib.js";\n');
    await fixture.write("src/lib.ts", "export const used = 1;\n");
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       (async () => {
         const { createKnipFilesystem } = await import(workerData.filesystem);
         const root = workerData.root;
         const view = await createKnipFilesystem({ repositoryRoot: root, snapshots: { baselineDir: root, targetDir: root } }, root, {});
         // Test only: select upstream's Windows WASI branch even on POSIX CI.
         // Host capture is already initialized; no production platform spoofing.
         Object.defineProperty(process, "platform", { value: "win32" });
         const { loadCapturedResolver } = await import(workerData.resolver);
         let runtime;
         try {
           runtime = loadCapturedResolver(view.fs);
           const resolver = new runtime.binding.ResolverFactory({ extensions: [".ts", ".js"], extensionAlias: { ".js": [".js", ".ts"] }, conditionNames: ["import", "node", "default"], nodePath: false });
           parentPort.postMessage([
             resolver.resolveFileSync("/snapshot/src/index.ts", "./lib.js"),
             resolver.resolveFileSync("/snapshot/src/index.ts", "#local"),
             resolver.resolveFileSync("/snapshot/src/index.ts", "C:/snapshot/src/lib.ts"),
           ]);
         } finally {
           runtime?.close();
           view.close();
           parentPort.close();
         }
       })().catch(error => { throw error; });`,
      {
        eval: true,
        execArgv: [],
        workerData: {
          root: await realpath(fixture.root),
          filesystem: new URL(
            "../../../dist/checks/dead-code/captured-filesystem.js",
            import.meta.url,
          ).href,
          resolver: new URL(
            "../../../dist/checks/dead-code/wasi.js",
            import.meta.url,
          ).href,
        },
      },
    );
    try {
      const results = await new Promise<unknown>((resolve, reject) => {
        let reply: unknown;
        worker.once("message", (value) => {
          reply = value;
        });
        worker.once("error", reject);
        worker.once("exit", (code) =>
          code === 0
            ? resolve(reply)
            : reject(new Error("Resolver fixture worker failed")),
        );
      });
      expect(results).toEqual([
        expect.objectContaining({ path: "/snapshot/src/lib.ts" }),
        expect.objectContaining({ path: "/snapshot/src/lib.ts" }),
        expect.objectContaining({ error: expect.any(String) }),
      ]);
      expect(worker.threadId).toBe(-1);
    } finally {
      await worker.terminate();
    }
  });
});
