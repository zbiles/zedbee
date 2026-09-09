import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { Worker } from "node:worker_threads";
import { HEX, ServiceUnavailableError } from "./protocol.js";

const digest = (value: string) =>
  createHash("sha256").update(value).digest("hex");
export interface ServiceIdentity {
  readonly key: string;
  readonly content: string;
  readonly entry: string;
  readonly directory: string;
}

/** A fresh worker hashes every acquisition; settlement includes worker exit. */
export function installedContentIdentity(
  root: string,
  tree: string,
): Promise<string> {
  const source = import.meta.url.endsWith(".ts");
  const entry = new URL(
    source ? "./identity-worker.ts" : "./identity-worker.js",
    import.meta.url,
  );
  return new Promise((resolve, reject) => {
    const worker = new Worker(entry, {
      execArgv: source ? ["--import", import.meta.resolve("tsx")] : [],
      workerData: { root, tree },
    });
    let content: string | undefined;
    let failed = false;
    worker.on("message", (value: unknown) => {
      if (
        content !== undefined ||
        typeof value !== "string" ||
        !HEX.test(value)
      )
        failed = true;
      else content = value;
    });
    worker.once("error", () => {
      failed = true;
    });
    worker.once("exit", (code) => {
      if (code !== 0 || failed || content === undefined)
        reject(new ServiceUnavailableError());
      else resolve(content);
    });
  });
}
export async function serviceLocation(directory?: string) {
  const source = import.meta.url.endsWith(".ts"),
    tree = source ? "src" : "dist";
  const root = await realpath(
    fileURLToPath(new URL("../../", import.meta.url)),
  );
  const runtime = [
    await realpath(process.execPath),
    process.version,
    process.versions.modules,
    process.platform,
    process.arch,
  ];
  const key = digest(JSON.stringify(["zedbee-service-v1", root, runtime]));
  return {
    key,
    root,
    tree,
    entry: join(root, tree, "service", `entry.${source ? "ts" : "js"}`),
    directory:
      directory ?? join(await realpath(tmpdir()), `zedbee-${key.slice(0, 24)}`),
  };
}
export async function serviceIdentity(
  directory?: string,
): Promise<ServiceIdentity> {
  const location = await serviceLocation(directory);
  return {
    key: location.key,
    entry: location.entry,
    directory: location.directory,
    content: digest(
      JSON.stringify([
        location.key,
        await installedContentIdentity(location.root, location.tree),
      ]),
    ),
  };
}
