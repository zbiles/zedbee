import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execa } from "execa";
import { inject, onTestFinished } from "vitest";

export interface TestGitOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface TestGitRepository {
  root: string;
  write(path: string, contents: string): Promise<void>;
  read(path: string): Promise<string>;
  git(args: readonly string[]): Promise<TestGitOutput>;
  commitAll(message: string): Promise<void>;
  cleanup(): Promise<void>;
}

function repositoryAt(root: string): TestGitRepository {
  let cleaned = false;

  const git = async (args: readonly string[]): Promise<TestGitOutput> => {
    const result = await execa("git", args, {
      cwd: root,
      reject: false,
      stdin: "ignore",
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode ?? -1,
    };
  };

  const cleanup = async (): Promise<void> => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    await rm(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  };

  return {
    root,
    async write(path, contents) {
      const fullPath = join(root, path);
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, contents);
    },
    read(path) {
      return readFile(join(root, path), "utf8");
    },
    git,
    async commitAll(message) {
      await git(["add", "--all"]);
      const result = await git(["commit", "--message", message]);
      if (result.exitCode !== 0) {
        throw new Error(
          `Test fixture commit failed with exit ${result.exitCode}.`,
        );
      }
    },
    cleanup,
  };
}

async function temporaryRepository(
  source: string,
  prefix: string,
): Promise<TestGitRepository> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  try {
    await cp(source, root, { recursive: true });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  const repository = repositoryAt(root);
  onTestFinished(repository.cleanup);
  return repository;
}

export function createGitRepository(
  prefix = "zedbee-test-repo-",
): Promise<TestGitRepository> {
  return temporaryRepository(inject("sharedGitTemplate"), prefix);
}

export function copyGitRepository(
  source: string,
  prefix = "zedbee-test-repo-",
): Promise<TestGitRepository> {
  return temporaryRepository(source, prefix);
}
