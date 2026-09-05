import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { onTestFinished, expect, it } from "vitest";
import * as globalSetup from "./global-setup.js";

interface InstallAttempt {
  readonly attempt: number;
  readonly attemptRoot: string;
  readonly installRoot: string;
  readonly cacheRoot: string;
}

interface PrepareVerifiedInstall {
  (
    scratch: string,
    install: (attempt: InstallAttempt) => Promise<void>,
    verify: (attempt: InstallAttempt) => Promise<void>,
  ): Promise<string>;
}

it("discards an incomplete shared install before retrying in a clean directory", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "zedbee-shared-retry-test-"));
  onTestFinished(() => rm(scratch, { recursive: true, force: true }));
  const prepare = (
    globalSetup as unknown as {
      prepareVerifiedInstall?: PrepareVerifiedInstall;
    }
  ).prepareVerifiedInstall;
  expect(prepare).toBeTypeOf("function");

  let firstAttemptRoot = "";
  let firstAttemptWasRemoved = false;
  const result = await prepare!(
    scratch,
    async (attempt) => {
      await mkdir(attempt.installRoot, { recursive: true });
      await mkdir(attempt.cacheRoot, { recursive: true });
      await writeFile(join(attempt.installRoot, "installed.txt"), "complete");
      if (attempt.attempt === 1) {
        firstAttemptRoot = attempt.attemptRoot;
      } else {
        try {
          await access(firstAttemptRoot);
        } catch {
          firstAttemptWasRemoved = true;
        }
      }
    },
    async ({ attempt }) => {
      if (attempt === 1) throw new Error("installed package is incomplete");
    },
  );

  expect(firstAttemptWasRemoved).toBe(true);
  expect(result).toBe(join(scratch, "shared-install-attempt-2", "installed"));
  await expect(access(join(result, "installed.txt"))).resolves.toBeUndefined();
});
