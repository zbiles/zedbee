import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import type { ResolverFactory } from "oxc-resolver";

const require = createRequire(import.meta.url);
/** The pinned same-engine artifact. Never use upstream's native-WASI host preopen. */
export function loadCapturedResolver(fs: typeof import("node:fs")) {
  const runtimeRequire = createRequire(
    require.resolve("@napi-rs/wasm-runtime"),
  );
  const wasiPath = new URL(
    "./wasi/path.js",
    pathToFileURL(runtimeRequire.resolve("@tybys/wasm-util")),
  ).href;
  // The pinned JS WASI shim otherwise interprets every path as a host Windows
  // path. Its filesystem here is exclusively virtual, including the preopen.
  // Replace only that shim's two path helpers before its first CJS evaluation.
  const pathHook = registerHooks({
    load(url, context, next) {
      return url === wasiPath
        ? {
            format: "commonjs",
            source:
              'const { posix } = require("node:path"); exports.resolve = (...paths) => posix.resolve("/", ...paths); exports.relative = posix.relative;',
            shortCircuit: true,
          }
        : next(url, context);
    },
  });
  let runtime;
  try {
    runtime = require("@napi-rs/wasm-runtime");
  } finally {
    pathHook.deregister();
  }
  const { WASI, instantiateNapiModuleSync } = runtime;
  const { createContext } = require("@emnapi/runtime");
  const bytes = readFileSync(new URL("./resolver.wasm", import.meta.url));
  if (
    bytes.length !== 1432002 ||
    createHash("sha256").update(bytes).digest("hex") !==
      "07f08138508b5b5832874cd5218ee1b7ac4ee987e01fbdc1a825512d380658b9"
  )
    throw new TypeError("Invalid pinned Knip resolver artifact");
  const context = createContext();
  const wasm = (
    globalThis as unknown as {
      WebAssembly: {
        Memory: new (options: {
          initial: number;
          maximum: number;
          shared: boolean;
        }) => unknown;
      };
    }
  ).WebAssembly;
  const memory = new wasm.Memory({ initial: 984, maximum: 4096, shared: true });
  const wasi = new WASI({
    version: "preview1",
    fs,
    preopens: { "/": "/" },
    env: {},
  });
  try {
    const result = instantiateNapiModuleSync(bytes, {
      context,
      wasi,
      asyncWorkPoolSize: 0,
      reuseWorker: false,
      onCreateWorker() {
        throw new Error("Unexpected asynchronous Knip resolver work");
      },
      overwriteImports(imports: Record<string, Record<string, unknown>>) {
        imports.env = {
          ...imports.env,
          ...imports.napi,
          ...imports.emnapi,
          memory,
        };
        return imports;
      },
      beforeInit({
        instance,
      }: {
        instance: { exports: Record<string, unknown> };
      }) {
        for (const [name, value] of Object.entries(instance.exports))
          if (
            name.startsWith("__napi_register__") &&
            typeof value === "function"
          )
            value();
      },
    });
    return {
      binding: result.napiModule.exports as {
        ResolverFactory: typeof ResolverFactory;
      },
      close: () => context.destroy(),
    };
  } catch (error) {
    context.destroy();
    throw error;
  }
}
