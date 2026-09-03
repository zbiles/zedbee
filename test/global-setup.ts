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
    sharedGitTemplate: string;
    sharedPackedNodeModules: string | null;
    sharedPackedTarball: string | null;
    sharedPackedTarballFiles: readonly string[] | null;
  }
}

export default async function setup(project: TestProject) {
  const useSharedInstall =
    process.platform === "win32" ||
    process.env.ZEDBEE_SHARED_PACKED_INSTALL_UNDER_TEST === "1";
  const scratch = await mkdtemp(join(tmpdir(), "zedbee-test-setup-"));
  const deadline = AbortSignal.timeout(240_000);
  try {
    const gitTemplate = join(scratch, "git-template");
    await mkdir(gitTemplate);
    await execa("git", ["init", "--initial-branch=main"], {
      cwd: gitTemplate,
      stdin: "ignore",
    });
    await execa("git", ["config", "user.name", "Zedbee Test"], {
      cwd: gitTemplate,
      stdin: "ignore",
    });
    await execa("git", ["config", "user.email", "zedbee@example.invalid"], {
      cwd: gitTemplate,
      stdin: "ignore",
    });
    project.provide("sharedGitTemplate", gitTemplate);

    if (!useSharedInstall) {
      project.provide("sharedPackedNodeModules", null);
      project.provide("sharedPackedTarball", null);
      project.provide("sharedPackedTarballFiles", null);
      return () => rm(scratch, { recursive: true, force: true });
    }

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
      readonly files: ReadonlyArray<{ readonly path: string }>;
    }>;
    const tarballPath = join(scratch, metadata[0]!.filename);
    const installRoot = join(scratch, "installed");
    await mkdir(installRoot);
    await writeFile(
      join(installRoot, "package.json"),
      '{"name":"zedbee-shared-windows-install","private":true}\n',
    );
    await installPackedFixture(
      tarballPath,
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
    project.provide("sharedPackedTarball", tarballPath);
    project.provide(
      "sharedPackedTarballFiles",
      metadata[0]!.files.map(({ path }) => path).sort(),
    );
  } catch (error) {
    await rm(scratch, { recursive: true, force: true });
    throw error;
  }

  return () => rm(scratch, { recursive: true, force: true });
}
