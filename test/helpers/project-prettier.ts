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
  const version = options.prettierVersion ?? "3.9.6";
  // The fixture installs a genuinely provisioned Prettier; a missing prepared
  // installation is a setup error, never simulated metadata.
  const sourcePackage =
    version === "3.0.3" ? "prettier-3-0-3" : "prettier";
  const sourceDirectory = join(
    repositoryPackageRoot,
    "node_modules",
    sourcePackage,
  );
  try {
    await lstat(join(sourceDirectory, "package.json"));
  } catch {
    throw new Error(
      `The prepared Prettier ${version} fixture installation is missing; install dependencies first.`,
    );
  }
  const declaredRange =
    version === "3.0.3" ? "3.0.3" : version === "3.9.6" ? "^3.0.0" : version;

  await repository.write(
    "package.json",
    `${JSON.stringify(
      {
        name: "prettier-fixture",
        private: true,
        devDependencies: { prettier: declaredRange },
      },
      null,
      2,
    )}\n`,
  );
  await mkdir(join(repository.root, "node_modules"), { recursive: true });
  await cp(
    sourceDirectory,
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
      const git = new GitClient(repository.root);
      // The declaration must be part of the selected snapshot, so the fixture
      // manifest is always staged before a session is opened.
      await repository.git(["add", "--", "package.json"]);
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
      const installation = await resolveProjectPrettierInstallation(
        repository.root,
        projectRoot,
        snapshot.targetDir,
      );
      if (installation.version !== version) {
        throw new Error(
          `Fixture expected Prettier ${version} but resolved ${installation.version}.`,
        );
      }
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
