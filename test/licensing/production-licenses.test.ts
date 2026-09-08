import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execa } from "execa";
import { describe, expect, it, onTestFinished } from "vitest";
import { NODE_ENGINE_RANGE } from "../../src/runtime/node-support.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const checkScriptPath = join(
  projectRoot,
  "scripts",
  "check-production-licenses.mjs",
);
const generateScriptPath = join(
  projectRoot,
  "scripts",
  "generate-production-licenses.mjs",
);
const inventoryScriptPath = join(
  projectRoot,
  "scripts",
  "production-license-inventory.mjs",
);
const fixtureRoot = join(projectRoot, "test", "fixtures", "licensing");

type LicenseResult =
  { allowed: true; selected: string } | { allowed: false; reason: string };

type Lockfile = {
  name: string;
  version: string;
  lockfileVersion: number;
  packages: Record<string, Record<string, unknown>>;
};

const { evaluateLicense, generateThirdPartyNotices } = (await import(
  pathToFileURL(checkScriptPath).href
)) as {
  evaluateLicense(license: string | undefined): LicenseResult;
  generateThirdPartyNotices(root: string): Promise<string>;
};
const { buildProductionInventory, findProductionDependencies } = (await import(
  pathToFileURL(inventoryScriptPath).href
)) as {
  buildProductionInventory(root: string): Promise<{
    schemaVersion: number;
    packages: Array<{
      name: string;
      version: string;
      license: string | null;
      repository: unknown;
      licenseFile: string | null;
      legalFiles: string[];
      dependencyPath: string[];
    }>;
  }>;
  findProductionDependencies(lockfile: Lockfile): Array<{
    packagePath: string;
    dependencyPath: string[];
  }>;
};

async function createFixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "zedbee-license-test-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function readLockfileFixture(filename: string): Promise<Lockfile> {
  return JSON.parse(
    await readFile(join(fixtureRoot, filename), "utf8"),
  ) as Lockfile;
}

async function writeLockfile(
  root: string,
  contents: Lockfile | string,
): Promise<void> {
  await writeFile(
    join(root, "package-lock.json"),
    typeof contents === "string"
      ? contents
      : `${JSON.stringify(contents, null, 2)}\n`,
  );
}

async function runLicenseCheck(root: string) {
  return execa(process.execPath, [checkScriptPath], {
    cwd: root,
    reject: false,
    stdin: "ignore",
  });
}

async function runLicenseGenerate(root: string) {
  return execa(process.execPath, [generateScriptPath], {
    cwd: root,
    reject: false,
    stdin: "ignore",
  });
}

async function writeAllowedFixture(root: string): Promise<void> {
  await writeLockfile(root, {
    name: "allowed-fixture",
    version: "1.0.0",
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { alpha: "1.0.0" } },
      "node_modules/alpha": { version: "1.0.0", license: "MIT" },
    },
  });
  await writePackage(root, "node_modules/alpha", {
    name: "alpha",
    version: "1.0.0",
    license: "MIT",
  });
}

async function writePackage(
  root: string,
  packagePath: string,
  metadata: Record<string, unknown>,
  licenseFile: string | null = "LICENSE",
): Promise<void> {
  const directory = join(root, packagePath);
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify(metadata, null, 2)}\n`,
  );
  if (licenseFile !== null) {
    await writeFile(join(directory, licenseFile), "fixture license\n");
  }
}

describe("evaluateLicense", () => {
  it("allows an allowlisted SPDX identifier", () => {
    expect(evaluateLicense("MIT")).toEqual({ allowed: true, selected: "MIT" });
  });

  it("allows an OR expression when either branch is allowlisted", () => {
    expect(evaluateLicense("(MIT OR GPL-3.0-only)")).toEqual({
      allowed: true,
      selected: "MIT",
    });
  });

  it("requires every branch of an AND expression to be allowlisted", () => {
    expect(evaluateLicense("(MIT AND Apache-2.0)").allowed).toBe(true);
    expect(evaluateLicense("(MIT AND LGPL-3.0-only)").allowed).toBe(false);
  });

  it("selects the allowed OR branch with the fewest attribution obligations", () => {
    expect(evaluateLicense("MPL-2.0 OR MIT")).toEqual({
      allowed: true,
      selected: "MIT",
    });
  });

  it.each([
    "GPL-3.0-only",
    "AGPL-3.0-only",
    "LGPL-3.0-only",
    "SSPL-1.0",
    "BUSL-1.1",
    "Commons-Clause",
    "PolyForm-Small-Business-1.0.0",
    "UNLICENSED",
    "SEE LICENSE IN LICENSE",
    "not valid SPDX (",
  ])("denies %s", (license) => {
    expect(evaluateLicense(license).allowed).toBe(false);
  });

  it("explains missing license metadata", () => {
    expect(evaluateLicense(undefined)).toEqual({
      allowed: false,
      reason: "missing license metadata",
    });
  });
});

describe("production dependency reachability", () => {
  it("walks dependencies and optional dependencies but excludes dev-only packages", () => {
    const lockfile: Lockfile = {
      name: "fixture-root",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "fixture-root",
          version: "1.0.0",
          dependencies: { "production-parent": "1.0.0" },
          optionalDependencies: { "optional-production": "1.0.0" },
          devDependencies: { "dev-only": "1.0.0" },
        },
        "node_modules/production-parent": {
          version: "1.0.0",
          dependencies: { "production-child": "2.0.0" },
        },
        "node_modules/production-child": { version: "2.0.0" },
        "node_modules/optional-production": {
          version: "1.0.0",
          optional: true,
        },
        "node_modules/dev-only": { version: "1.0.0", dev: true },
      },
    };

    expect(
      findProductionDependencies(lockfile).map(
        ({ packagePath }) => packagePath,
      ),
    ).toEqual([
      "node_modules/optional-production",
      "node_modules/production-child",
      "node_modules/production-parent",
    ]);
  });

  it("includes required peers and excludes optional peers from a real v3 lockfile", async () => {
    const root = await createFixtureRoot();
    const lockfile = await readLockfileFixture("peer-package-lock.json");
    await writeLockfile(root, lockfile);
    await writePackage(root, "node_modules/production-plugin", {
      name: "production-plugin",
      version: "1.0.0",
      license: "MIT",
    });
    await writePackage(root, "node_modules/required-peer", {
      name: "required-peer",
      version: "2.0.0",
      license: "LGPL-3.0-only",
    });
    await writePackage(root, "node_modules/optional-peer", {
      name: "optional-peer",
      version: "3.0.0",
      license: "GPL-3.0-only",
    });

    const result = await runLicenseCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "peer-fixture@1.0.0 > production-plugin@1.0.0 > required-peer@2.0.0",
    );
    expect(result.stderr).not.toContain("optional-peer@3.0.0");
    const inventory = await buildProductionInventory(root);
    expect(inventory.packages.map(({ name }) => name)).toEqual([
      "production-plugin",
      "required-peer",
    ]);
  });

  it("follows a contained workspace link target from a real v3 lockfile", async () => {
    const root = await createFixtureRoot();
    const lockfile = await readLockfileFixture(
      "workspace-link-package-lock.json",
    );
    await writeLockfile(root, lockfile);
    await writePackage(root, "packages/production-workspace", {
      name: "production-workspace",
      version: "1.0.0",
      license: "MIT",
    });
    await mkdir(join(root, "node_modules"), { recursive: true });
    await symlink(
      join(root, "packages", "production-workspace"),
      join(root, "node_modules", "production-workspace"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await writePackage(root, "node_modules/denied-workspace-child", {
      name: "denied-workspace-child",
      version: "2.0.0",
      license: "AGPL-3.0-only",
    });

    const result = await runLicenseCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "workspace-link-fixture@1.0.0 > production-workspace@1.0.0 > denied-workspace-child@2.0.0",
    );
  });
});

describe("production license inventory", () => {
  it("reads installed metadata and emits packages in deterministic name/version order", async () => {
    const root = await createFixtureRoot();
    const lockfile: Lockfile = {
      name: "fixture-root",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "fixture-root",
          version: "1.0.0",
          license: "PolyForm-Small-Business-1.0.0",
          dependencies: { zeta: "1.0.0", alpha: "2.0.0" },
        },
        "node_modules/zeta": { version: "1.0.0", license: "ISC" },
        "node_modules/alpha": { version: "2.0.0", license: "MIT" },
      },
    };
    await writeFile(
      join(root, "package-lock.json"),
      `${JSON.stringify(lockfile, null, 2)}\n`,
    );
    await writePackage(
      root,
      "node_modules/zeta",
      {
        name: "zeta",
        version: "1.0.0",
        license: "ISC",
        repository: "example/zeta",
      },
      "LICENCE.md",
    );
    await writePackage(
      root,
      "node_modules/alpha",
      {
        name: "alpha",
        version: "2.0.0",
        license: "MIT",
        repository: { type: "git", url: "https://example.test/alpha.git" },
      },
      "LICENSE",
    );

    const inventory = await buildProductionInventory(root);

    expect(inventory).toEqual({
      schemaVersion: 1,
      packages: [
        {
          name: "alpha",
          version: "2.0.0",
          license: "MIT",
          repository: { type: "git", url: "https://example.test/alpha.git" },
          licenseFile: "node_modules/alpha/LICENSE",
          legalFiles: ["node_modules/alpha/LICENSE"],
          dependencyPath: ["fixture-root@1.0.0", "alpha@2.0.0"],
        },
        {
          name: "zeta",
          version: "1.0.0",
          license: "ISC",
          repository: "example/zeta",
          licenseFile: "node_modules/zeta/LICENCE.md",
          legalFiles: ["node_modules/zeta/LICENCE.md"],
          dependencyPath: ["fixture-root@1.0.0", "zeta@1.0.0"],
        },
      ],
    });
  });

  it("includes optional platform packages that are not installed on the current OS", async () => {
    const root = await createFixtureRoot();
    await writeLockfile(root, {
      name: "fixture-root",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "fixture-root",
          version: "1.0.0",
          optionalDependencies: {
            "native-linux": "1.0.0",
            "native-windows": "1.0.0",
          },
        },
        "node_modules/native-linux": {
          version: "1.0.0",
          license: "MIT",
          optional: true,
          os: ["linux"],
        },
        "node_modules/native-windows": {
          version: "1.0.0",
          license: "MIT",
          optional: true,
          os: ["win32"],
          repository: "example/native-windows",
        },
      },
    });
    await writePackage(root, "node_modules/native-linux", {
      name: "native-linux",
      version: "1.0.0",
      license: "MIT",
      repository: "installed metadata must not affect the inventory",
    });

    const inventory = await buildProductionInventory(root);

    expect(inventory.packages).toEqual([
      {
        name: "native-linux",
        version: "1.0.0",
        license: "MIT",
        repository: null,
        licenseFile: null,
        legalFiles: [],
        dependencyPath: ["fixture-root@1.0.0", "native-linux@1.0.0"],
      },
      {
        name: "native-windows",
        version: "1.0.0",
        license: "MIT",
        repository: "example/native-windows",
        licenseFile: null,
        legalFiles: [],
        dependencyPath: ["fixture-root@1.0.0", "native-windows@1.0.0"],
      },
    ]);
  });

  it("fails the command with a denied transitive dependency's complete path", async () => {
    const root = await createFixtureRoot();
    const lockfile: Lockfile = {
      name: "fixture-root",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "fixture-root",
          version: "1.0.0",
          license: "PolyForm-Small-Business-1.0.0",
          dependencies: { "production-parent": "1.0.0" },
        },
        "node_modules/production-parent": {
          version: "1.0.0",
          license: "MIT",
          dependencies: { "denied-child": "2.0.0" },
        },
        "node_modules/denied-child": {
          version: "2.0.0",
          license: "LGPL-3.0-only",
        },
      },
    };
    await writeFile(
      join(root, "package-lock.json"),
      `${JSON.stringify(lockfile, null, 2)}\n`,
    );
    await writePackage(root, "node_modules/production-parent", {
      name: "production-parent",
      version: "1.0.0",
      license: "MIT",
    });
    await writePackage(root, "node_modules/denied-child", {
      name: "denied-child",
      version: "2.0.0",
      license: "LGPL-3.0-only",
    });

    const result = await runLicenseCheck(root);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("LGPL-3.0-only");
    expect(result.stderr).toContain(
      "fixture-root@1.0.0 > production-parent@1.0.0 > denied-child@2.0.0",
    );
    const writtenInventory = await buildProductionInventory(root);
    expect(writtenInventory.packages).toHaveLength(2);
  });

  it("uses incomplete exit code 2 for malformed JSON", async () => {
    const root = await createFixtureRoot();
    await writeLockfile(root, "{ not valid JSON\n");

    const result = await runLicenseCheck(root);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("package-lock.json");
  });

  it.each([
    {
      name: "an unsupported lockfile version",
      lockfile: {
        name: "unsupported-version",
        version: "1.0.0",
        lockfileVersion: 2,
        packages: { "": { name: "unsupported-version", version: "1.0.0" } },
      },
    },
    {
      name: "a malformed packages collection",
      lockfile: {
        name: "malformed-packages",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: [],
      },
    },
  ])("uses incomplete exit code 2 for $name", async ({ lockfile }) => {
    const root = await createFixtureRoot();
    await writeLockfile(root, lockfile as unknown as Lockfile);

    const result = await runLicenseCheck(root);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("package-lock.json");
  });

  it("uses incomplete exit code 2 when required installed metadata is unreadable", async () => {
    const root = await createFixtureRoot();
    await writeLockfile(root, {
      name: "missing-metadata",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "missing-metadata",
          version: "1.0.0",
          dependencies: { required: "1.0.0" },
        },
        "node_modules/required": { version: "1.0.0", license: "MIT" },
      },
    });

    const result = await runLicenseCheck(root);

    expect(result.exitCode).toBe(2);
    expect(result.stderr.replaceAll("\\", "/")).toContain(
      "node_modules/required/package.json",
    );
  });

  it("rejects escaping lockfile paths before reading outside the repository", async () => {
    const base = await createFixtureRoot();
    const root = join(base, "repository");
    await mkdir(root, { recursive: true });
    await writeLockfile(root, {
      name: "containment-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "containment-fixture",
          version: "1.0.0",
          dependencies: { "../../outside-package": "1.0.0" },
        },
        "node_modules/../../outside-package": {
          version: "1.0.0",
          license: "MIT",
        },
      },
    });
    await writePackage(
      base,
      "outside-package",
      { name: "outside-package", version: "1.0.0", license: "MIT" },
      "LICENSE",
    );

    const result = await runLicenseCheck(root);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("unsafe package-lock.json path");
    await expect(
      readFile(join(root, "licenses", "production-inventory.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("captures every legal file and generates deterministic complete notices", async () => {
    const root = await createFixtureRoot();
    await writeLockfile(root, {
      name: "notice-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { alpha: "1.0.0" } },
        "node_modules/alpha": { version: "1.0.0", license: "MIT" },
      },
    });
    await writePackage(root, "node_modules/alpha", {
      name: "alpha",
      version: "1.0.0",
      license: "MIT",
    });
    await writeFile(
      join(root, "node_modules/alpha/NOTICE"),
      "alpha notice with upstream spaces   \n",
    );
    await writeFile(
      join(root, "node_modules/alpha/COPYING.md"),
      "alpha copying\n",
    );

    const inventory = await buildProductionInventory(root);
    const first = await generateThirdPartyNotices(root);
    const second = await generateThirdPartyNotices(root);

    expect(inventory.packages[0]?.legalFiles).toEqual([
      "node_modules/alpha/COPYING.md",
      "node_modules/alpha/LICENSE",
      "node_modules/alpha/NOTICE",
    ]);
    expect(second).toBe(first);
    expect(first).toContain("## alpha@1.0.0");
    expect(first).toContain("fixture license");
    expect(first).toContain("alpha copying");
    expect(first).toContain("alpha notice with upstream spaces\n");
    expect(first).not.toMatch(/[ \t]+$/mu);
  });

  it("fails closed when an allowed production package has no license text", async () => {
    const root = await createFixtureRoot();
    await writeLockfile(root, {
      name: "missing-text",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { alpha: "1.0.0" } },
        "node_modules/alpha": { version: "1.0.0", license: "MIT" },
      },
    });
    await writePackage(
      root,
      "node_modules/alpha",
      { name: "alpha", version: "1.0.0", license: "MIT" },
      null,
    );

    await expect(generateThirdPartyNotices(root)).rejects.toThrow(
      /missing license.*text/i,
    );
  });

  it.each([
    { name: "axe-core", version: "4.13.0", license: "MPL-2.0" },
    {
      name: "caniuse-lite",
      version: "1.0.30001809",
      license: "CC-BY-4.0",
    },
  ])(
    "requires reviewed obligations for $name@$version",
    async ({ name, version, license }) => {
      const root = await createFixtureRoot();
      await writeLockfile(root, {
        name: "obligation-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { [name]: version } },
          [`node_modules/${name}`]: { version, license },
        },
      });
      await writePackage(root, `node_modules/${name}`, {
        name,
        version,
        license,
      });

      await expect(generateThirdPartyNotices(root)).rejects.toThrow(
        /reviewed obligation/i,
      );

      await mkdir(join(root, "licenses"), { recursive: true });
      await writeFile(
        join(root, "licenses", "reviewed-obligations.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          obligations: [
            {
              name,
              version,
              license,
              sourceUrl: `https://example.test/source/${name}/${version}`,
              attribution: `${name} upstream contributors`,
              changes: "none",
              notice: "Zedbee distributes this dependency unmodified.",
            },
          ],
        })}\n`,
      );

      const notices = await generateThirdPartyNotices(root);
      expect(notices).toContain(
        `Source: https://example.test/source/${name}/${version}`,
      );
      expect(notices).toContain(`Attribution: ${name} upstream contributors`);
      expect(notices).toContain("Changes: none");
      expect(notices).toContain(
        "Zedbee distributes this dependency unmodified.",
      );
    },
  );

  it.each([
    ["MPL-2.0 AND MIT", "MPL-2.0"],
    ["MIT AND CC-BY-4.0", "CC-BY-4.0"],
  ])(
    "requires an exact reviewed obligation for compound license %s",
    async (license, obligationLicense) => {
      const root = await createFixtureRoot();
      await writeLockfile(root, {
        name: "compound-obligation-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { alpha: "1.0.0" } },
          "node_modules/alpha": { version: "1.0.0", license },
        },
      });
      await writePackage(root, "node_modules/alpha", {
        name: "alpha",
        version: "1.0.0",
        license,
      });

      await expect(generateThirdPartyNotices(root)).rejects.toThrow(
        new RegExp(`reviewed obligation.*${obligationLicense}`, "i"),
      );

      await mkdir(join(root, "licenses"), { recursive: true });
      await writeFile(
        join(root, "licenses", "reviewed-obligations.json"),
        `${JSON.stringify({
          schemaVersion: 1,
          obligations: [
            {
              name: "alpha",
              version: "1.0.0",
              license: obligationLicense,
              sourceUrl: "https://example.test/alpha/1.0.0",
              attribution: "Alpha contributors",
              changes: "none",
              notice: "Alpha obligation notice.",
            },
          ],
        })}\n`,
      );

      await expect(generateThirdPartyNotices(root)).resolves.toContain(
        "Alpha obligation notice.",
      );
    },
  );

  it("does not require an unselected obligation from an OR expression", async () => {
    const root = await createFixtureRoot();
    await writeLockfile(root, {
      name: "or-obligation-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": { dependencies: { alpha: "1.0.0" } },
        "node_modules/alpha": {
          version: "1.0.0",
          license: "MPL-2.0 OR MIT",
        },
      },
    });
    await writePackage(root, "node_modules/alpha", {
      name: "alpha",
      version: "1.0.0",
      license: "MPL-2.0 OR MIT",
    });

    await expect(generateThirdPartyNotices(root)).resolves.not.toContain(
      "Compliance notice:",
    );
  });

  it.each([
    ["removed", "1.0.0"],
    ["alpha", "9.9.9"],
  ])("rejects a stale reviewed obligation for %s@%s", async (name, version) => {
    const root = await createFixtureRoot();
    await writeAllowedFixture(root);
    await mkdir(join(root, "licenses"), { recursive: true });
    await writeFile(
      join(root, "licenses", "reviewed-obligations.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        obligations: [
          {
            name,
            version,
            license: "MPL-2.0",
            sourceUrl: "https://example.test/stale",
            attribution: "Stale contributors",
            changes: "none",
            notice: "Stale notice.",
          },
        ],
      })}\n`,
    );

    await expect(generateThirdPartyNotices(root)).rejects.toThrow(
      /stale reviewed obligation/i,
    );
  });

  it("accepts only the reviewed exact-version Yoga override", async () => {
    const root = await createFixtureRoot();
    await mkdir(join(root, "licenses", "overrides"), { recursive: true });
    await writeFile(
      join(root, "licenses", "reviewed-overrides.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        overrides: [
          {
            name: "yoga-layout",
            version: "3.2.1",
            license: "MIT",
            sourceUrl:
              "https://raw.githubusercontent.com/facebook/yoga/v3.2.1/LICENSE",
            textFile: "licenses/overrides/yoga-layout-3.2.1-LICENSE",
          },
        ],
      })}\n`,
    );
    await writeFile(
      join(root, "licenses", "overrides", "yoga-layout-3.2.1-LICENSE"),
      "reviewed Yoga MIT text\n",
    );
    const writeYoga = async (version: string) => {
      await writeLockfile(root, {
        name: "yoga-fixture",
        version: "1.0.0",
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { "yoga-layout": version } },
          "node_modules/yoga-layout": { version, license: "MIT" },
        },
      });
      await writePackage(
        root,
        "node_modules/yoga-layout",
        { name: "yoga-layout", version, license: "MIT" },
        null,
      );
    };

    await writeYoga("3.2.1");
    await expect(generateThirdPartyNotices(root)).resolves.toContain(
      "reviewed Yoga MIT text",
    );
    await writeYoga("3.2.2");
    await expect(generateThirdPartyNotices(root)).rejects.toThrow(
      /missing license.*text/i,
    );
  });
});

describe("package metadata", () => {
  it("preserves the named caniuse-lite author attribution", async () => {
    const metadata = JSON.parse(
      await readFile(
        join(projectRoot, "licenses", "reviewed-obligations.json"),
        "utf8",
      ),
    ) as { obligations: Array<{ name: string; attribution: string }> };

    expect(
      metadata.obligations.find(({ name }) => name === "caniuse-lite")
        ?.attribution,
    ).toMatch(/Ben Briggs/);
  });

  it("reviews every ast-grep platform package at the exact pinned version", async () => {
    const astGrepMetadata = JSON.parse(
      await readFile(
        join(projectRoot, "node_modules", "@ast-grep", "napi", "package.json"),
        "utf8",
      ),
    ) as { optionalDependencies?: Record<string, string> };
    const reviewedMetadata = JSON.parse(
      await readFile(
        join(projectRoot, "licenses", "reviewed-overrides.json"),
        "utf8",
      ),
    ) as {
      overrides: Array<{
        name: string;
        version: string;
        sourceUrl: string;
        textFile: string;
      }>;
    };
    const astGrepOverrides = reviewedMetadata.overrides
      .filter(({ name }) => name.startsWith("@ast-grep/napi-"))
      .map(({ name, version, sourceUrl, textFile }) => ({
        name,
        version,
        sourceUrl,
        textFile,
      }))
      .sort((left, right) => (left.name < right.name ? -1 : 1));
    const expected = Object.entries(astGrepMetadata.optionalDependencies ?? {})
      .map(([name, version]) => ({
        name,
        version,
        sourceUrl:
          "https://raw.githubusercontent.com/ast-grep/ast-grep/0.45.1/LICENSE",
        textFile: "licenses/overrides/ast-grep-platform-0.45.1-LICENSE",
      }))
      .sort((left, right) => (left.name < right.name ? -1 : 1));

    expect(astGrepOverrides).toEqual(expected);
  });

  it("keeps license verification non-mutating when artifacts are missing", async () => {
    const root = await createFixtureRoot();
    await writeAllowedFixture(root);

    const result = await runLicenseCheck(root);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/missing|stale/i);
    await expect(
      readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(join(root, "licenses", "production-inventory.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite stale license artifacts during verification", async () => {
    const root = await createFixtureRoot();
    await writeAllowedFixture(root);
    await mkdir(join(root, "licenses"), { recursive: true });
    await writeFile(join(root, "THIRD_PARTY_NOTICES.md"), "stale notices\n");
    await writeFile(
      join(root, "licenses", "production-inventory.json"),
      "stale inventory\n",
    );

    const result = await runLicenseCheck(root);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/stale/i);
    expect(await readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8")).toBe(
      "stale notices\n",
    );
    expect(
      await readFile(
        join(root, "licenses", "production-inventory.json"),
        "utf8",
      ),
    ).toBe("stale inventory\n");
  });

  it("rejects byte-different invalid UTF-8 without rewriting the artifact", async () => {
    const root = await createFixtureRoot();
    await writeAllowedFixture(root);
    await writeFile(
      join(root, "node_modules", "alpha", "LICENSE"),
      "fixture \uFFFD license\n",
    );
    await runLicenseGenerate(root);
    const noticesPath = join(root, "THIRD_PARTY_NOTICES.md");
    const generated = await readFile(noticesPath);
    const replacement = Buffer.from("\uFFFD", "utf8");
    const replacementOffset = generated.indexOf(replacement);
    expect(replacementOffset).toBeGreaterThanOrEqual(0);
    const invalidUtf8 = Buffer.concat([
      generated.subarray(0, replacementOffset),
      Buffer.from([0xff]),
      generated.subarray(replacementOffset + replacement.length),
    ]);
    await writeFile(noticesPath, invalidUtf8);

    const result = await runLicenseCheck(root);

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toMatch(/stale/i);
    expect(await readFile(noticesPath)).toEqual(invalidUtf8);
  });

  it("generates deterministic artifacts explicitly before verification", async () => {
    const root = await createFixtureRoot();
    await writeAllowedFixture(root);

    const firstResult = await runLicenseGenerate(root);
    expect(firstResult.exitCode).toBe(0);
    const first = await Promise.all([
      readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
      readFile(join(root, "licenses", "production-inventory.json"), "utf8"),
    ]);
    const secondResult = await runLicenseGenerate(root);
    expect(secondResult.exitCode).toBe(0);
    const second = await Promise.all([
      readFile(join(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
      readFile(join(root, "licenses", "production-inventory.json"), "utf8"),
    ]);

    expect(second).toEqual(first);
    await expect(runLicenseCheck(root)).resolves.toMatchObject({ exitCode: 0 });
  });

  it("keeps the approved Node runtime support range", async () => {
    const packageMetadata = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as { engines?: { node?: string } };

    expect(packageMetadata.engines?.node).toBe(NODE_ENGINE_RANGE);
  });

  it("exposes explicit generation and keeps prepack verification non-mutating", async () => {
    const packageMetadata = JSON.parse(
      await readFile(join(projectRoot, "package.json"), "utf8"),
    ) as { scripts?: Record<string, string> };

    expect(packageMetadata.scripts?.["licenses:generate"]).toBe(
      "node scripts/generate-production-licenses.mjs",
    );
    expect(packageMetadata.scripts?.prepack).toBe(
      "npm run build && npm run licenses:check",
    );
  });
});
