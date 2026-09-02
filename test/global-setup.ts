import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { TestProject } from "vitest/node";
import { installPackedFixture } from "./helpers/packed-install.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

declare module "vitest" {
  export interface ProvidedContext {
    sharedPackedNodeModules: string | null;
  }
}

export default async function setup(project: TestProject) {
  const useSharedInstall =
    process.platform === "win32" ||
    process.env.ZEDBEE_SHARED_PACKED_INSTALL_UNDER_TEST === "1";
  if (!useSharedInstall) {
    project.provide("sharedPackedNodeModules", null);
    return;
  }

  const scratch = await mkdtemp(join(tmpdir(), "zedbee-shared-install-"));
  const deadline = AbortSignal.timeout(240_000);
  try {
    const packed = await execa(
      "npm",
      ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
      {
        cwd: packageRoot,
        cancelSignal: deadline,
        env: { npm_config_cache: join(scratch, "pack-cache") },
        killDescendants: true,
        reject: false,
        stdin: "ignore",
        timeout: 120_000,
      },
    );
    if (packed.exitCode !== 0) {
      throw new Error(`Could not pack the shared Windows fixture: ${packed.stderr}`);
    }
    const metadata = JSON.parse(packed.stdout) as Array<{
      readonly filename: string;
    }>;
    const installRoot = join(scratch, "installed");
    await mkdir(installRoot);
    await writeFile(
      join(installRoot, "package.json"),
      '{"name":"zedbee-shared-windows-install","private":true}\n',
    );
    await installPackedFixture(
      join(scratch, metadata[0]!.filename),
      packageRoot,
      installRoot,
      join(scratch, "install-cache"),
      {
        cancelSignal: deadline,
        retryTimedOutInstall: true,
        reuseSharedInstall: false,
      },
    );
    project.provide(
      "sharedPackedNodeModules",
      join(installRoot, "node_modules"),
    );
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }

  return () => rm(scratch, { recursive: true, force: true });
}
