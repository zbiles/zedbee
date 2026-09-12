import nodeFs from "node:fs";
import nodePromises from "node:fs/promises";
import { createRequire, registerHooks } from "node:module";
import { dirname, posix } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parentPort, workerData } from "node:worker_threads";
import {
  importAnalysisSourceCapture,
  withAnalysisSourceCapture,
} from "../../inspection/source-capture.js";
import {
  createKnipFilesystem,
  MANAGED_CONFIG,
  VIRTUAL_ROOT,
} from "./captured-filesystem.js";
import { loadCapturedResolver } from "./wasi.js";
import type { KnipJob } from "./executor.js";
import { createPackageMetadataReader } from "./package-metadata.js";

const require = createRequire(import.meta.url);
const globals = globalThis as unknown as Record<string, unknown>;
const ISSUE_TYPES = new Set([
  "files",
  "dependencies",
  "devDependencies",
  "unlisted",
  "unresolved",
  "exports",
  "types",
  "nsExports",
  "nsTypes",
  "duplicates",
]);

function reportFor(result: {
  issues: Record<
    string,
    Record<string, Record<string, Record<string, unknown>>>
  >;
}) {
  const rows = new Map<string, Record<string, unknown>>();
  const convert = (issue: Record<string, unknown>) => ({
    name: issue.symbol,
    line: issue.line,
    col: issue.col,
  });
  for (const [type, files] of Object.entries(result.issues)) {
    if (!ISSUE_TYPES.has(type)) continue;
    for (const issues of Object.values(files))
      for (const issue of Object.values(issues)) {
        if (
          typeof issue.filePath !== "string" ||
          !issue.filePath.startsWith(`${VIRTUAL_ROOT}/`)
        )
          throw new TypeError("Knip issue escaped snapshot");
        const file = posix.relative(VIRTUAL_ROOT, issue.filePath);
        const row = rows.get(file) ?? { file };
        const list = (row[type] ?? []) as unknown[];
        if (type === "duplicates") {
          if (!Array.isArray(issue.symbols))
            throw new TypeError("Invalid Knip duplicate symbols");
          list.push(issue.symbols.map(convert));
        } else list.push(convert(issue));
        row[type] = list;
        rows.set(file, row);
      }
  }
  return { issues: [...rows.values()] };
}

async function run(job: KnipJob) {
  const view = await createKnipFilesystem(
    job.context,
    job.snapshotRoot,
    job.config,
  );
  let resolver: ReturnType<typeof loadCapturedResolver> | undefined;
  let hooks: ReturnType<typeof registerHooks> | undefined;
  try {
    // Fixed trusted native parser takes source strings; load its binding before
    // filesystem substitution. User configuration/plugins are always disabled.
    await import(pathToFileURL(require.resolve("oxc-parser")).href);
    resolver = loadCapturedResolver(view.fs);
    globals.__zedbeeKnipFs = view.fs;
    globals.__zedbeeKnipPromises = view.fs.promises;
    globals.__zedbeeKnipResolver = resolver.binding;
    globals.__zedbeeKnipPath = posix;
    globals.__zedbeeKnipPackageMetadata = createPackageMetadataReader(
      view.capture,
    );
    // These snapshot crawlers otherwise resolve /snapshot against the host's
    // current drive on Windows. Only their own path imports use virtual POSIX
    // semantics; trusted module loading and host capture retain native paths.
    const knipRequire = createRequire(import.meta.resolve("knip"));
    const manifestOwner = new URL(
      "./manifest/helpers.js",
      import.meta.resolve("knip"),
    ).href;
    const globRequire = createRequire(knipRequire.resolve("tinyglobby"));
    const virtualPathOwners = [
      knipRequire.resolve("tinyglobby"),
      globRequire.resolve("fdir"),
    ].map((entry) => pathToFileURL(`${dirname(entry)}/`).href);
    const source = (name: string, keys: string[]) =>
      `const value=globalThis.${name}; export default value; ${keys
        .filter((key) => /^[A-Za-z_$][\w$]*$/u.test(key))
        .map((key) => `export const ${key}=value.${key};`)
        .join("\n")}`;
    const sources: Record<string, string> = {
      "zedbee-knip:package-metadata":
        "export const _require = globalThis.__zedbeeKnipPackageMetadata;",
      "zedbee-knip:fs": source("__zedbeeKnipFs", Object.keys(nodeFs)),
      "zedbee-knip:promises": source(
        "__zedbeeKnipPromises",
        Object.keys(nodePromises),
      ),
      "zedbee-knip:resolver": source("__zedbeeKnipResolver", [
        "ResolverFactory",
      ]),
      "zedbee-knip:path": source("__zedbeeKnipPath", Object.keys(posix)),
    };
    const replacements = new Map([
      ["fs", "zedbee-knip:fs"],
      ["node:fs", "zedbee-knip:fs"],
      ["fs/promises", "zedbee-knip:promises"],
      ["node:fs/promises", "zedbee-knip:promises"],
      ["oxc-resolver", "zedbee-knip:resolver"],
    ]);
    hooks = registerHooks({
      resolve(specifier, context, next) {
        if (
          context.parentURL === manifestOwner &&
          specifier === "../util/require.js"
        )
          return { url: "zedbee-knip:package-metadata", shortCircuit: true };
        if (
          (specifier === "path" || specifier === "node:path") &&
          virtualPathOwners.some((owner) =>
            context.parentURL?.startsWith(owner),
          )
        )
          return { url: "zedbee-knip:path", shortCircuit: true };
        const url = replacements.get(specifier);
        return url === undefined
          ? next(specifier, context)
          : { url, shortCircuit: true };
      },
      load(url, context, next) {
        return sources[url] === undefined
          ? next(url, context)
          : { format: "module", source: sources[url], shortCircuit: true };
      },
    });
    const entry = fileURLToPath(import.meta.resolve("knip"));
    const { main } = await import(pathToFileURL(entry).href);
    const { createOptions } = await import(
      pathToFileURL(`${dirname(entry)}/util/create-options.js`).href
    );
    const options = await createOptions({
      cwd: VIRTUAL_ROOT,
      gitignore: false,
      isShowProgress: false,
      isFix: false,
      args: {
        config: MANAGED_CONFIG,
        workspace: job.workspace,
        tsConfig: ".zedbee-managed-no-tsconfig.json",
        "no-progress": true,
        "no-config-hints": true,
        "no-tag-hints": true,
        "no-gitignore": true,
      },
    });
    const result = await main(options);
    view.assertComplete();
    const report = reportFor(result);
    if (Buffer.byteLength(JSON.stringify(report)) > 64 * 1024 * 1024)
      throw new RangeError("Knip output capacity");
    return { report, dependencyInputs: view.capture.manifest() };
  } finally {
    hooks?.deregister();
    resolver?.close();
    view.close();
    delete globals.__zedbeeKnipFs;
    delete globals.__zedbeeKnipPromises;
    delete globals.__zedbeeKnipPackageMetadata;
    delete globals.__zedbeeKnipResolver;
    delete globals.__zedbeeKnipPath;
  }
}

if (parentPort !== null) {
  const job = workerData as KnipJob;
  let source;
  try {
    source =
      job.sourceCapture === undefined
        ? undefined
        : importAnalysisSourceCapture(job.sourceCapture);
    const result =
      source === undefined
        ? await run(job)
        : await withAnalysisSourceCapture(source, () => run(job));
    parentPort.postMessage({ type: "result", ...result });
  } catch {
    // Never send source-bearing engine errors across the worker boundary.
    parentPort.postMessage({ type: "error" });
  } finally {
    await source?.close();
    parentPort.close();
  }
}
