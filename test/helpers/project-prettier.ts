import { cp, lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { GitClient } from "../../src/git/client.js";
import {
  buildCommitSnapshotPair,
  buildSnapshotPair,
  type SnapshotPair,
} from "../../src/git/snapshot.js";
import {
  openProjectFormatter,
  resolveProjectPrettierInstallation,
  type ProjectFormatterSession,
} from "../../src/checks/prettier/project-engine.js";
import { requireProjectPrettierTrust } from "../../src/checks/prettier/project-trust.js";
import {
  createGitRepository,
  type TestGitRepository,
} from "./git-repository.js";

const repositoryPackageRoot = fileURLToPath(new URL("../../", import.meta.url));

export interface ProjectPrettierFixture {
  readonly root: string;
  write(file: string, text: string): Promise<void>;
  stage(...files: string[]): Promise<void>;
  commit(): Promise<void>;
  open(options: {
    source: "index" | "commit";
    trust: boolean;
    projectRoot?: string;
  }): Promise<ProjectFormatterSession>;
  markerExists(name?: string): Promise<boolean>;
  dispose(): Promise<void>;
}

export async function createProjectPrettierFixture(
  options: { prettierVersion?: string } = {},
): Promise<ProjectPrettierFixture> {
  const repository: TestGitRepository = await createGitRepository(
    "zedbee-project-prettier-",
  );
  const sessions: ProjectFormatterSession[] = [];
  const snapshots: SnapshotPair[] = [];

  await repository.write(
    "package.json",
    `${JSON.stringify(
      {
        name: "prettier-fixture",
        private: true,
        devDependencies: { prettier: options.prettierVersion ?? "3.9.6" },
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(join(repository.root, "node_modules"), { recursive: true });
  await cp(
    join(repositoryPackageRoot, "node_modules", "prettier"),
    join(repository.root, "node_modules", "prettier"),
    { recursive: true },
  );

  const write = async (file: string, text: string): Promise<void> => {
    const fullPath = join(repository.root, file);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, text);
  };

  return {
    root: repository.root,
    write,
    async stage(...files) {
      await repository.git(["add", "--", ...files]);
    },
    async commit() {
      await repository.git(["add", "--all"]);
      const result = await repository.git([
        "commit",
        "--message",
        "fixture commit",
        "--no-verify",
      ]);
      if (result.exitCode !== 0) {
        throw new Error(`Fixture commit failed: ${result.stderr}`);
      }
    },
    async open({ source, trust, projectRoot = "." }) {
      const permit = await requireProjectPrettierTrust(
        repository.root,
        projectRoot,
        trust,
      );
      const installation = await resolveProjectPrettierInstallation(
        repository.root,
        projectRoot,
        ">=3.0.0 <4.0.0",
      );
      const git = new GitClient(repository.root);
      const snapshot =
        source === "commit"
          ? await buildCommitSnapshotPair(
              repository.root,
              git,
              "HEAD",
              "HEAD",
            )
          : await buildSnapshotPair(repository.root, git);
      snapshots.push(snapshot);
      const session = await openProjectFormatter({
        checkoutRoot: await realpath(repository.root),
        snapshotRoot: snapshot.targetDir,
        projectRoot,
        installation,
        permit,
        signal: new AbortController().signal,
      });
      sessions.push(session);
      return session;
    },
    async markerExists(name = "MARKER_EXECUTED") {
      try {
        await lstat(join(repository.root, name));
        return true;
      } catch {
        return false;
      }
    },
    async dispose() {
      for (const session of sessions.splice(0)) {
        await session.close().catch(() => undefined);
      }
      for (const snapshot of snapshots.splice(0)) {
        await snapshot.cleanup().catch(() => undefined);
      }
      await repository.cleanup();
    },
  };
}

export async function readFixtureFile(
  root: string,
  file: string,
): Promise<string> {
  return readFile(join(root, file), "utf8");
}
