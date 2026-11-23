import assert from "node:assert/strict";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const previousReleases = {
  "0.1.0-beta.15":
    "sha512-fMFVnN6GA4ACYQNyNcSYANnq37aZxBmWV0/P0xGa7tVDzdYQxSQqpTdxl8lG8LxWy099IMTfu2G6nx+tquRIbg==",
  "0.1.0-beta.18":
    "sha512-OFs3AP8RuF2Yu/XOsapCv1PfnWeAVjMYR/bT3osmL8WyUFpwpeN8wC208OtVleb1z8BTiXkymF1CZJK7SSBPlA==",
  "0.1.0-beta.19":
    "sha512-0DRp50E7OVIsoLZOu++PlsyAMSYmHu7avihtH936j5hCXCv9cN4+ks08iNKktLm6jLF2EGW9buGk48Whjj7CHQ==",
  "0.1.0-beta.20":
    "sha512-rhIbzcamxSH6vhCsFOR38uaxbMIZ5VkgIcc2cGlX0MX+Xr1+p6UF3qxJ092IoKUFCW6GiYdzrCoTh1bP8McPGQ==",
};
const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + "\n");

export function assertUpgradeCommit(report, expected) {
  assert.equal(report.mode, "index");
  assert.equal(report.changedFileCount, expected.files);
  assert.equal(report.exitCode, expected.error ? 1 : 0);
  assert.equal(report.outcome, expected.error ? "blocked" : "pass");
  assert.ok(report.checks.every((check) => check.status !== "incomplete"));
  for (const id of ["lint", "types"]) {
    const check = report.checks.find(
      (check) => check.checkId === id && check.target === expected.workspace,
    );
    assert.equal(
      check?.status,
      "completed",
      `${id} must run in ${expected.workspace}`,
    );
    assert.equal(check.comparisonContext?.status, "comparable");
  }
  if (expected.healthySibling) {
    for (const id of ["lint", "types"]) {
      const sibling = report.checks.find(
        (check) =>
          check.checkId === id && check.target === expected.healthySibling,
      );
      assert.ok(
        sibling?.status === "skipped" ||
          (sibling?.status === "completed" &&
            sibling.comparisonContext?.status === "comparable"),
      );
    }
  }
  if (expected.skipped) {
    for (const id of ["lint", "types"]) {
      assert.ok(
        report.checks.some(
          (check) =>
            check.checkId === id &&
            check.target === expected.skipped &&
            check.status === "skipped",
        ),
      );
    }
  }
  if (expected.error) {
    assert.ok(
      report.checks.some(
        (check) =>
          check.target === expected.workspace &&
          check.findings.some(
            (finding) => finding.rule === "typescript/TS2322",
          ),
      ),
    );
  } else {
    assert.ok(report.checks.every((check) => check.findings.length === 0));
  }
}

export function previousUpgradeVersions(version) {
  return Object.keys(previousReleases).filter(
    (previous) => previous !== version,
  );
}

function smokeFreshLinkedWorktree({ hook, linked, git, cliRun }) {
  const setup = JSON.parse(
    cliRun([
      "init",
      "--hook",
      "husky",
      "--workflow",
      "none",
      "--yes",
      "--format",
      "json",
    ]),
  );
  assert.equal(setup.applied, true);
  assert.equal(setup.proposal.hookActivation.status, "active");
  const runtime = setup.proposal.files.filter(({ relativePath }) =>
    relativePath.startsWith(".husky/_/"),
  );
  const executable = runtime.filter(({ mode }) => (mode & 0o111) !== 0);
  const data = runtime.filter(
    ({ relativePath, mode }) =>
      (mode & 0o111) === 0 && relativePath !== ".husky/_/.gitignore",
  );
  assert.ok(
    executable.some(
      ({ relativePath }) => relativePath === ".husky/_/pre-commit",
    ),
  );
  assert.ok(
    executable.some(
      ({ relativePath }) => relativePath === ".husky/_/pre-merge-commit",
    ),
  );
  assert.ok(data.some(({ relativePath }) => relativePath === ".husky/_/h"));
  const body = readFileSync(hook, "utf8");
  assert.match(body, /Zedbee could not start/u);
  writeFileSync(
    hook,
    body.replace(
      "scan --hook-invocation",
      "scan --hook-invocation --format json --no-color --no-animations --no-service",
    ),
  );
  git(["add", "--all"]);
  git([
    "add",
    "--force",
    "--chmod=+x",
    "--",
    ...executable.map(({ relativePath }) => relativePath),
  ]);
  git([
    "add",
    "--force",
    "--",
    ...data.map(({ relativePath }) => relativePath),
  ]);
  git(["commit", "--no-gpg-sign", "-m", "Track worktree hook activation"]);
  const base = git(["rev-parse", "HEAD"]);
  git(["worktree", "add", "--detach", linked, base]);
  const linkedGit = (args, options) => git(args, { cwd: linked, ...options });
  try {
    const assertSetupBlocked = (args) => {
      const output = linkedGit(args, {
        expectedStatuses: [1],
        combinedOutput: true,
      });
      assert.match(output, /Zedbee could not start/u);
      assert.match(output, /web\/node_modules\/zedbee/u);
      assert.equal(linkedGit(["rev-parse", "HEAD"]), base);
    };
    assertSetupBlocked([
      "commit",
      "--allow-empty",
      "--no-gpg-sign",
      "-m",
      "Uninstalled commit",
    ]);
    writeFileSync(join(linked, "incoming.md"), "Incoming worktree change.\n");
    linkedGit(["add", "incoming.md"]);
    linkedGit([
      "commit",
      "--no-gpg-sign",
      "--no-verify",
      "-m",
      "Incoming change",
    ]);
    const incoming = linkedGit(["rev-parse", "HEAD"]);
    linkedGit(["checkout", "--detach", base]);
    assertSetupBlocked([
      "merge",
      "--no-ff",
      "--no-edit",
      "--no-gpg-sign",
      incoming,
    ]);
  } finally {
    // The blocked merge intentionally leaves an in-progress merge in this fixture.
    git(["worktree", "remove", "--force", linked]);
  }
}

export function smokeConsumerUpgrades({
  root,
  version,
  scratch,
  archive,
  run,
}) {
  const versions = previousUpgradeVersions(version);
  for (const previous of versions) {
    const fixture = join(scratch, `upgrade-${previous}`);
    const web = join(fixture, "web");
    const e2e = join(fixture, "e2e");
    const extension = join(fixture, "extension");
    for (const project of [web, e2e, extension])
      mkdirSync(project, { recursive: true });
    const npmFlags = [
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry=https://registry.npmjs.org",
    ];
    const env = {
      ...process.env,
      npm_config_cache: join(scratch, "consumer-npm-cache"),
      ZEDBEE_TELEMETRY_DISABLED: "1",
      HUSKY: "1",
    };
    const git = (args, options = {}) =>
      run("git", args, {
        cwd: fixture,
        env,
        label: args[0],
        ...options,
      }).trim();
    const npm = (cwd, args) =>
      run("npm", [...args, ...npmFlags], {
        cwd,
        env,
        label: "Consumer fixture installation",
      });
    const installed = join(web, "node_modules", "zedbee");
    const cli = join(installed, "dist", "cli.js");
    const cliRun = (args) =>
      run(process.execPath, [cli, ...args], {
        cwd: fixture,
        env,
        label: args[0],
      }).trim();

    git(["init", "--initial-branch=main"]);
    git(["config", "user.name", "Swarm Release Smoke"]);
    git(["config", "user.email", "swarm-release@example.invalid"]);
    writeFileSync(join(fixture, ".gitignore"), "node_modules/\n.husky/_/\n");
    for (const [name, directory, devDependencies] of [
      ["web", web, { husky: "9.1.7", zedbee: previous }],
      ["extension", extension, {}],
      ["e2e", e2e, { "@playwright/test": "1.58.2", "@types/node": "26.1.0" }],
    ]) {
      writeJson(join(directory, "package.json"), {
        name,
        private: true,
        devDependencies,
      });
      writeJson(join(directory, "tsconfig.json"), {
        compilerOptions: {
          module: "esnext",
          moduleResolution: "bundler",
          baseUrl: ".",
          paths: { "@fixture/*": ["./*"] },
          strict: true,
        },
        include: ["*.ts"],
      });
      writeFileSync(join(directory, "value.ts"), "export const value = 1;\n");
      npm(directory, ["install"]);
    }
    const webManifest = join(web, "package.json");
    const webLock = join(web, "package-lock.json");
    assert.equal(
      readJson(webLock).packages["node_modules/zedbee"].integrity,
      previousReleases[previous],
    );
    assert.equal(readJson(join(installed, "package.json")).version, previous);
    const e2eTest = join(e2e, "example.spec.ts");
    const goodTest =
      'import { expect, test } from "@playwright/test";\nimport { value } from "@fixture/value";\ntest("example", () => {\n  expect(value).toBe(1);\n});\n';
    writeFileSync(e2eTest, goodTest);
    cliRun([
      "init",
      "--hook",
      "husky",
      "--workflow",
      "none",
      "--yes",
      "--format",
      "json",
    ]);
    const hook = join(fixture, ".husky", "pre-commit");
    const hookContents = readFileSync(hook, "utf8");
    assert.match(
      hookContents,
      /web\/node_modules\/zedbee\/dist\/cli\.js[^\n]*scan --hook-invocation/u,
    );
    // Keep the installed hook entry point and collect an assertable report.
    writeFileSync(
      hook,
      hookContents.replace(
        "scan --hook-invocation",
        "scan --hook-invocation --format json --no-color --no-animations --no-service",
      ),
    );
    run(process.execPath, [join(web, "node_modules", "husky", "bin.js")], {
      cwd: fixture,
      env,
      label: "Install the consumer Husky hook",
    });
    git(["add", "--all"]);
    git([
      "commit",
      "--no-gpg-sign",
      "--no-verify",
      "--message",
      "consumer on previous release",
    ]);

    if (archive === undefined) {
      writeFileSync(
        cli,
        `import { main } from ${JSON.stringify(pathToFileURL(join(root, "dist", "cli.js")).href)};\nprocess.exitCode = await main();\n`,
      );
      // The build preflight runs before packing, against a representative
      // upgrade diff. The archive rehearsal below uses npm-generated files.
      const manifest = readJson(webManifest);
      const lock = readJson(webLock);
      manifest.devDependencies.zedbee = version;
      lock.packages[""].devDependencies.zedbee = version;
      lock.packages["node_modules/zedbee"].version = version;
      writeJson(webManifest, manifest);
      writeJson(webLock, lock);
    } else {
      const integrity = run(
        process.execPath,
        [
          fileURLToPath(
            new URL("./install-candidate-from-registry.mjs", import.meta.url),
          ),
          root,
          archive,
        ],
        {
          cwd: web,
          env,
          label: "Install the exact version from the fixture registry",
        },
      ).trim();
      assert.equal(readJson(join(installed, "package.json")).version, version);
      assert.equal(readJson(webManifest).devDependencies.zedbee, version);
      const lock = readJson(webLock);
      assert.equal(lock.packages[""].devDependencies.zedbee, version);
      assert.equal(lock.packages["node_modules/zedbee"].integrity, integrity);
    }

    function commit(paths, expected) {
      git(["add", "--", ...paths]);
      assert.deepEqual(
        git(["diff", "--cached", "--name-only"]).split("\n").sort(),
        [...paths].sort(),
      );
      const before = git(["rev-parse", "HEAD"]);
      const output = git(
        ["commit", "--no-gpg-sign", "--message", "upgrade smoke"],
        {
          expectedStatuses: [expected.error ? 1 : 0],
          combinedOutput: true,
        },
      );
      assert.ok(
        output.includes("{"),
        `Missing hook report from ${paths.join(", ")}.\n${output}`,
      );
      const report = JSON.parse(
        output.slice(output.indexOf("{"), output.lastIndexOf("}") + 1),
      );
      assertUpgradeCommit(report, { ...expected, files: paths.length });
      assert.ok(
        report.checks.some(
          (check) => check.comparisonContext?.swarmVersion === version,
        ),
      );
      const after = git(["rev-parse", "HEAD"]);
      assert.equal(after === before, Boolean(expected.error));
    }

    commit(["web/package.json", "web/package-lock.json"], {
      workspace: "web",
      healthySibling: "e2e",
    });
    const installation = join(e2e, "node_modules");
    const removedInstallation = join(scratch, `e2e-install-${previous}`);
    renameSync(installation, removedInstallation);
    writeFileSync(join(web, "value.ts"), "export const value = 2;\n");
    commit(["web/value.ts"], { workspace: "web", skipped: "e2e" });
    mkdirSync(join(fixture, "api"));
    writeFileSync(
      join(fixture, "api", "pyproject.toml"),
      '[project]\nname = "fixture"\n',
    );
    git(["add", "api/pyproject.toml"]);
    const apiOutput = git(
      ["commit", "--no-gpg-sign", "-m", "API manifest only"],
      { combinedOutput: true },
    );
    const apiReport = JSON.parse(
      apiOutput.slice(apiOutput.indexOf("{"), apiOutput.lastIndexOf("}") + 1),
    );
    assert.equal(apiReport.outcome, "pass");
    assert.equal(apiReport.changedFileCount, 1);
    for (const id of ["lint", "types"]) {
      const checks = apiReport.checks.filter((check) => check.checkId === id);
      assert.ok(
        checks.length > 0 &&
          checks.every((check) => check.status === "skipped"),
      );
    }
    renameSync(removedInstallation, installation);
    if (archive !== undefined && previous === versions[0]) {
      // Restore the stock previous hook before testing managed-hook migration.
      writeFileSync(hook, hookContents);
      smokeFreshLinkedWorktree({
        hook,
        linked: join(scratch, "fresh-linked-worktree"),
        git,
        cliRun,
      });
    }
    writeFileSync(e2eTest, goodTest.replace("toBe(1)", "toEqual(1)"));
    commit(["e2e/example.spec.ts"], { workspace: "e2e" });
    writeFileSync(e2eTest, goodTest + "export const broken: string = 1;\n");
    commit(["e2e/example.spec.ts"], { workspace: "e2e", error: true });
  }
  return versions;
}
