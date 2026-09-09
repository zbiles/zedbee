import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import type { ResolverFactory } from "oxc-resolver";

const require = createRequire(import.meta.url);
/** The pinned same-engine artifact. Never use upstream's native-WASI host preopen. */
export function loadCapturedResolver(fs: typeof import("node:fs")) {
  const runtimeUrl = pathToFileURL(
    require.resolve("@napi-rs/wasm-runtime"),
  ).href;
  const helperUrl = pathToFileURL(require.resolve("@tybys/wasm-util"));
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", helperUrl), "utf8"),
  );
  if (manifest.name !== "@tybys/wasm-util" || manifest.version !== "0.10.3") {
    throw new TypeError("Unsupported captured WASI helper installation");
  }
  const wasiPath = new URL("./wasi/path.js", helperUrl).href;
  // The pinned JS WASI shim otherwise interprets every path as a host Windows
  // path. Its filesystem here is exclusively virtual, including the preopen.
  // Replace only that shim's two path helpers before its first CJS evaluation.
  let helperApplied = false;
  const pathHook = registerHooks({
    resolve(specifier, context, next) {
      // Own this exact dependency even when the parent runtime has a different
      // nested version. Published consumers do not use our package-lock.json.
      return specifier === "@tybys/wasm-util" &&
        context.parentURL === runtimeUrl
        ? { url: helperUrl.href, shortCircuit: true }
        : next(specifier, context);
    },
    load(url, context, next) {
      if (url === wasiPath) helperApplied = true;
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
  if (!helperApplied) {
    throw new TypeError("Could not install the protected WASI path helper");
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
