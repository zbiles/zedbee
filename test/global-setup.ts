import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { execa } from "execa";
import type { TestProject } from "vitest/node";
import { installPackedFixture } from "./helpers/packed-install.js";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

export interface InstallAttempt {
  readonly attempt: number;
  readonly attemptRoot: string;
  readonly installRoot: string;
  readonly cacheRoot: string;
}

export async function prepareVerifiedInstall(
  scratch: string,
  install: (attempt: InstallAttempt) => Promise<void>,
  verify: (attempt: InstallAttempt) => Promise<void>,
): Promise<string> {
  const failures: unknown[] = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const attemptRoot = join(scratch, `shared-install-attempt-${attempt}`);
    const details = {
      attempt,
      attemptRoot,
      installRoot: join(attemptRoot, "installed"),
      cacheRoot: join(attemptRoot, "npm-cache"),
    };
    try {
      await install(details);
      await verify(details);
      return details.installRoot;
    } catch (error) {
      failures.push(error);
      await rm(attemptRoot, { recursive: true, force: true }).catch(() => {});
    }
  }
  throw new AggregateError(
    failures,
    "Could not create a complete shared packed-package installation after 2 attempts.",
  );
}

async function verifySharedPackedInstall(
  installRoot: string,
  repositoryRoot: string,
  cancelSignal: AbortSignal,
): Promise<void> {
  const result = await execa(
    process.execPath,
    [
      join(installRoot, "node_modules", "zedbee", "dist", "cli.js"),
      "checks",
      "--format",
      "json",
    ],
    {
      cwd: repositoryRoot,
      cancelSignal,
      env: { ...process.env, NO_COLOR: "1" },
      killDescendants: true,
      reject: false,
      stdin: "ignore",
      timeout: 30_000,
    },
  );
  if (result.exitCode !== 0) {
    throw new Error(
      `Shared packed-package verification failed: ${result.stderr.trim() || result.stdout.trim() || "no output"}`,
    );
  }
  let report: unknown;
  try {
    report = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      "Shared packed-package verification returned invalid JSON.",
      {
        cause: error,
      },
    );
  }
  if (
    typeof report !== "object" ||
    report === null ||
    !("checks" in report) ||
    !Array.isArray(report.checks)
  ) {
    throw new Error(
      "Shared packed-package verification returned no check catalog.",
    );
  }
}

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
      throw new Error(
        `Could not pack the shared Windows fixture: ${packed.stderr}`,
      );
    }
    const metadata = JSON.parse(packed.stdout) as Array<{
      readonly filename: string;
      readonly files: ReadonlyArray<{ readonly path: string }>;
    }>;
    const tarballPath = join(scratch, metadata[0]!.filename);
    const installRoot = await prepareVerifiedInstall(
      scratch,
      async (attempt) => {
        await mkdir(attempt.installRoot, { recursive: true });
        await writeFile(
          join(attempt.installRoot, "package.json"),
          '{"name":"zedbee-shared-windows-install","private":true}\n',
        );
        await installPackedFixture(
          tarballPath,
          packageRoot,
          attempt.installRoot,
          attempt.cacheRoot,
          {
            cancelSignal: deadline,
            reuseSharedInstall: false,
          },
        );
      },
      (attempt) =>
        verifySharedPackedInstall(attempt.installRoot, gitTemplate, deadline),
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
