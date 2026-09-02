import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { cruise } from "dependency-cruiser";
import { execa } from "execa";
import { describe, expect, onTestFinished, test } from "vitest";
import {
  createManagedOutputDirectory,
  writeManagedJsonConfig,
} from "../../../src/checks/project/config-boundary.js";
import { createGitRepository } from "../../helpers/git-repository.js";

function isContainedBy(parent: string, child: string): boolean {
  const pathFromParent = relative(parent, child);
  return (
    pathFromParent !== "" &&
    !isAbsolute(pathFromParent) &&
    pathFromParent !== ".." &&
    !pathFromParent.startsWith(`..${sep}`)
  );
}

describe("writeManagedJsonConfig", () => {
  test("writes data-only JSON beneath a private temporary directory", async () => {
    const managed = await writeManagedJsonConfig("knip", {
      entry: ["src/index.ts"],
      project: ["src/**/*.{ts,tsx}"],
    });
    onTestFinished(managed.cleanup);

    const parent = dirname(managed.path);
    expect(
      isContainedBy(await realpath(tmpdir()), await realpath(parent)),
    ).toBe(true);
    expect(await readFile(managed.path, "utf8")).toBe(
      '{\n  "entry": [\n    "src/index.ts"\n  ],\n  "project": [\n    "src/**/*.{ts,tsx}"\n  ]\n}\n',
    );
    if (process.platform !== "win32") {
      expect((await lstat(parent)).mode & 0o777).toBe(0o700);
      expect((await lstat(managed.path)).mode & 0o777).toBe(0o600);
    }
  });

  test.each(["", ".", "../escape", "nested/config", "/tmp/escape"])(
    "rejects an unsafe managed config name: %j",
    async (name) => {
      await expect(writeManagedJsonConfig(name, {})).rejects.toThrow(
        /managed config name/i,
      );
    },
  );

  test("cleanup is idempotent and removes only its managed directory", async () => {
    const outside = await mkdtemp(join(tmpdir(), "zedbee-config-outside-"));
    onTestFinished(() => rm(outside, { recursive: true, force: true }));
    const marker = join(outside, "keep.txt");
    await writeFile(marker, "keep\n");
    const managed = await writeManagedJsonConfig("knip", { marker });
    const parent = dirname(managed.path);

    await managed.cleanup();
    await managed.cleanup();

    await expect(access(parent)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(marker, "utf8")).resolves.toBe("keep\n");
  });

  test("refuses cleanup when the config file is replaced by a symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "zedbee-config-target-"));
    onTestFinished(() => rm(outside, { recursive: true, force: true }));
    const marker = join(outside, "keep.json");
    await writeFile(marker, "{}\n");
    const managed = await writeManagedJsonConfig("knip", {});
    const parent = dirname(managed.path);
    onTestFinished(() => rm(parent, { recursive: true, force: true }));
    await rm(managed.path);
    await symlink(marker, managed.path);

    await expect(managed.cleanup()).rejects.toThrow(/managed config path/i);
    await expect(readFile(marker, "utf8")).resolves.toBe("{}\n");
  });

  test("refuses cleanup when the config file is replaced by a regular file", async () => {
    const managed = await writeManagedJsonConfig("knip", {});
    const parent = dirname(managed.path);
    onTestFinished(() => rm(parent, { recursive: true, force: true }));
    await rm(managed.path);
    await writeFile(managed.path, "replacement\n");

    await expect(managed.cleanup()).rejects.toThrow(
      /(?:identity|contents) changed/i,
    );
    await expect(readFile(managed.path, "utf8")).resolves.toBe("replacement\n");
  });

  test("refuses cleanup when the config file is overwritten in place", async () => {
    const managed = await writeManagedJsonConfig("knip", {});
    const parent = dirname(managed.path);
    onTestFinished(() => rm(parent, { recursive: true, force: true }));
    await writeFile(managed.path, "[]\n");

    await expect(managed.cleanup()).rejects.toThrow(/contents changed/i);
    await expect(readFile(managed.path, "utf8")).resolves.toBe("[]\n");
  });

  test("refuses cleanup when the managed directory is replaced", async () => {
    const managed = await writeManagedJsonConfig("knip", {});
    const parent = dirname(managed.path);
    const moved = `${parent}-original`;
    onTestFinished(() => rm(parent, { recursive: true, force: true }));
    onTestFinished(() => rm(moved, { recursive: true, force: true }));
    await rename(parent, moved);
    await mkdir(parent, { mode: 0o700 });
    await writeFile(managed.path, "replacement\n", { mode: 0o600 });

    await expect(managed.cleanup()).rejects.toThrow(/identity changed/i);
    await expect(readFile(managed.path, "utf8")).resolves.toBe("replacement\n");
  });
});

describe("createManagedOutputDirectory", () => {
  test("reads only an expected regular JSON artifact and cleans it", async () => {
    const output = await createManagedOutputDirectory("jscpd", [
      "jscpd-report.json",
    ]);
    await writeFile(join(output.path, "jscpd-report.json"), '{"ok":true}\n');

    await expect(output.readJson("jscpd-report.json")).resolves.toEqual({
      ok: true,
    });
    await output.cleanup();
    await output.cleanup();
    await expect(access(output.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("rejects unexpected output and refuses broad cleanup", async () => {
    const output = await createManagedOutputDirectory("jscpd", [
      "jscpd-report.json",
    ]);
    onTestFinished(() => rm(output.path, { recursive: true, force: true }));
    await writeFile(join(output.path, "unexpected.json"), "{}\n");

    await expect(output.readJson("unexpected.json")).rejects.toThrow(
      /unexpected managed artifact/i,
    );
    await expect(output.cleanup()).rejects.toThrow(/unexpected artifacts/i);
    await expect(access(join(output.path, "unexpected.json"))).resolves.toBe(
      undefined,
    );
  });

  test("rejects a symlinked expected artifact", async () => {
    const output = await createManagedOutputDirectory("jscpd", [
      "jscpd-report.json",
    ]);
    const outside = await mkdtemp(join(tmpdir(), "zedbee-output-target-"));
    onTestFinished(() => rm(output.path, { recursive: true, force: true }));
    onTestFinished(() => rm(outside, { recursive: true, force: true }));
    const target = join(outside, "report.json");
    await writeFile(target, "{}\n");
    await symlink(target, join(output.path, "jscpd-report.json"));

    await expect(output.readJson("jscpd-report.json")).rejects.toThrow(
      /unsafe managed artifact/i,
    );
    await expect(output.cleanup()).rejects.toThrow(/unsafe managed artifact/i);
    await expect(readFile(target, "utf8")).resolves.toBe("{}\n");
  });
});

async function writeExecutableConfigSentinels(): Promise<{
  root: string;
  markerPaths: readonly string[];
}> {
  const repository = await createGitRepository("zedbee-project-boundary-");
  const packageMarker = join(repository.root, "PACKAGE_KNIP_CONFIG_READ");
  const jscpdMarker = join(repository.root, "JSCPD_CONFIG_EXECUTED");
  const dependencyMarker = join(
    repository.root,
    "DEPENDENCY_CRUISER_CONFIG_EXECUTED",
  );
  const knipMarker = join(repository.root, "KNIP_CONFIG_EXECUTED");
  await repository.write(
    "package.json",
    JSON.stringify(
      {
        name: "project-config-sentinel",
        version: "1.0.0",
        type: "module",
        scripts: {
          zedbeeSentinel: `node -e ${JSON.stringify(
            `require("node:fs").writeFileSync(${JSON.stringify(packageMarker)}, "executed")`,
          )}`,
        },
        knip: {
          entry: ["knip.ts"],
          project: ["knip.ts"],
        },
      },
      null,
      2,
    ),
  );
  await repository.write(
    ".jscpd.js",
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(jscpdMarker)}, "executed");\nexport default {};\n`,
  );
  await repository.write(
    ".dependency-cruiser.cjs",
    `require("node:fs").writeFileSync(${JSON.stringify(dependencyMarker)}, "executed");\nmodule.exports = {};\n`,
  );
  await repository.write(
    "knip.ts",
    `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(knipMarker)}, "executed");\nexport default {};\n`,
  );
  await repository.write("src/index.js", "export const value = 1;\n");
  return {
    root: repository.root,
    markerPaths: [packageMarker, jscpdMarker, dependencyMarker, knipMarker],
  };
}

async function expectSentinelsUntouched(
  markerPaths: readonly string[],
): Promise<void> {
  for (const markerPath of markerPaths) {
    await expect(access(markerPath)).rejects.toMatchObject({ code: "ENOENT" });
  }
}

describe("project analyzer configuration isolation", () => {
  test("jscpd uses only its explicit managed JSON config", async () => {
    const fixture = await writeExecutableConfigSentinels();
    const managed = await writeManagedJsonConfig("jscpd", {
      minTokens: 30,
      minLines: 3,
      format: ["javascript", "jsx", "typescript", "tsx"],
      reporters: ["silent"],
    });
    onTestFinished(managed.cleanup);
    const cliPath = fileURLToPath(import.meta.resolve("jscpd/run-jscpd.js"));

    const result = await execa(
      process.execPath,
      [cliPath, "--config", managed.path, join(fixture.root, "src")],
      {
        cwd: fixture.root,
        shell: false,
        reject: false,
        stdin: "ignore",
      },
    );

    expect(result.exitCode).toBe(0);
    await expectSentinelsUntouched(fixture.markerPaths);
  });

  test("dependency-cruiser API does not discover project configuration", async () => {
    const fixture = await writeExecutableConfigSentinels();

    const result = await cruise(["src/index.js"], {
      baseDir: fixture.root,
      outputType: "json",
      validate: false,
    });

    expect(result.exitCode).toBe(0);
    await expectSentinelsUntouched(fixture.markerPaths);
  });

  test("Knip uses only its explicit managed JSON config", async () => {
    const fixture = await writeExecutableConfigSentinels();
    const managed = await writeManagedJsonConfig("knip", {
      entry: ["src/index.js"],
      project: ["src/**/*.js"],
    });
    onTestFinished(managed.cleanup);
    const knipModule = fileURLToPath(import.meta.resolve("knip"));
    const cliPath = join(dirname(knipModule), "..", "bin", "knip.js");

    const result = await execa(
      process.execPath,
      [
        cliPath,
        "--config",
        managed.path,
        "--directory",
        fixture.root,
        "--reporter",
        "json",
        "--no-progress",
      ],
      {
        cwd: fixture.root,
        shell: false,
        reject: false,
        stdin: "ignore",
      },
    );

    expect(result.exitCode, result.stderr).toBe(0);
    await expectSentinelsUntouched(fixture.markerPaths);
  });
});
