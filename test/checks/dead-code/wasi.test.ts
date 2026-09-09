import { Worker } from "node:worker_threads";
import { readFile, realpath } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createInspectionFixture } from "../../inspection/fixture.js";

describe("captured WASI resolver path namespace", () => {
  it.each([false, true])(
    "keeps the pinned POSIX resolver when Windows is detected (nested helper differs: %s)",
    async (differentNestedHelper) => {
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
         const { createRequire, registerHooks } = require("node:module");
         const { pathToFileURL } = require("node:url");
         const localRequire = createRequire(workerData.resolver);
         const runtimeUrl = pathToFileURL(localRequire.resolve("@napi-rs/wasm-runtime")).href;
         const nestedHelper = workerData.differentNestedHelper ? registerHooks({
           resolve(specifier, context, next) {
             if (specifier === "@tybys/wasm-util" && context.parentURL === runtimeUrl)
               throw new Error("Unreviewed nested helper selected");
             return next(specifier, context);
           }
         }) : undefined;
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
           nestedHelper?.deregister();
           view.close();
           parentPort.close();
         }
       })().catch(error => { throw error; });`,
        {
          eval: true,
          execArgv: [],
          workerData: {
            differentNestedHelper,
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
    },
  );

  it("rejects an unreviewed helper version before executing it", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write(
      "wasi.mjs",
      await readFile(
        new URL("../../../dist/checks/dead-code/wasi.js", import.meta.url),
        "utf8",
      ),
    );
    await fixture.writeJson("node_modules/@napi-rs/wasm-runtime/package.json", {
      name: "@napi-rs/wasm-runtime",
      main: "runtime.cjs",
    });
    await fixture.write(
      "node_modules/@napi-rs/wasm-runtime/runtime.cjs",
      'throw new Error("Unreviewed runtime executed");',
    );
    await fixture.writeJson("node_modules/@tybys/wasm-util/package.json", {
      name: "@tybys/wasm-util",
      version: "0.10.4",
      main: "lib/cjs/index.js",
    });
    await fixture.write(
      "node_modules/@tybys/wasm-util/lib/cjs/index.js",
      'throw new Error("Unreviewed helper executed");',
    );
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       import(workerData.resolver).then(({ loadCapturedResolver }) => {
         try { loadCapturedResolver(require("node:fs")); parentPort.postMessage("unexpected success"); }
         catch (error) { parentPort.postMessage(error.message); }
         finally { parentPort.close(); }
       }).catch(error => { throw error; });`,
      {
        eval: true,
        execArgv: [],
        workerData: {
          resolver: pathToFileURL(join(fixture.root, "wasi.mjs")).href,
        },
      },
    );
    try {
      const result = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(result).toMatch(/Unsupported captured WASI helper/u);
    } finally {
      await worker.terminate();
    }
  });

  it("rejects a runtime loaded before the protected path helper was installed", async () => {
    const worker = new Worker(
      `const { parentPort, workerData } = require("node:worker_threads");
       const { createRequire } = require("node:module");
       (async () => {
         const localRequire = createRequire(workerData.resolver);
         localRequire("@napi-rs/wasm-runtime");
         const { loadCapturedResolver } = await import(workerData.resolver);
         let runtime;
         try {
           runtime = loadCapturedResolver(require("node:fs"));
           parentPort.postMessage("unexpected success");
         } catch (error) {
           parentPort.postMessage(error.message);
         } finally { runtime?.close(); parentPort.close(); }
       })().catch(error => { throw error; });`,
      {
        eval: true,
        execArgv: [],
        workerData: {
          resolver: new URL(
            "../../../dist/checks/dead-code/wasi.js",
            import.meta.url,
          ).href,
        },
      },
    );
    try {
      const result = await new Promise((resolve, reject) => {
        worker.once("message", resolve);
        worker.once("error", reject);
      });
      expect(result).toMatch(/protected WASI path helper/u);
    } finally {
      await worker.terminate();
    }
  });
});
