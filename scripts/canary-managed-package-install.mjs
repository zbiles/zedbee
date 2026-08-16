import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const platformPackage = argument("--package");
if (platformPackage === undefined) {
  throw new Error("Use --package <platform-package-directory>.");
}

const root = resolve(import.meta.dirname, "..");
const scratch = await mkdtemp(join(tmpdir(), "zedbee-managed-install-"));
const artifacts = join(scratch, "artifacts");
const fixture = join(scratch, "fixture");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

async function pack(path) {
  const result = await execa(
    npm,
    [
      "pack",
      path,
      "--json",
      "--ignore-scripts",
      "--pack-destination",
      artifacts,
    ],
    { cwd: root, shell: false, stdin: "ignore" },
  );
  const output = JSON.parse(result.stdout);
  return join(artifacts, output[0].filename);
}

try {
  await mkdir(artifacts);
  await mkdir(fixture);
  await writeFile(
    join(fixture, "package.json"),
    '{"name":"zedbee-managed-install-canary","private":true}\n',
  );
  const [coreTarball, platformTarball] = await Promise.all([
    pack(root),
    pack(resolve(platformPackage)),
  ]);
  await execa(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-package-lock",
      "--no-audit",
      "--no-fund",
      "--omit=optional",
      coreTarball,
      platformTarball,
    ],
    { cwd: fixture, shell: false, stdin: "ignore" },
  );
  const result = await execa(
    process.execPath,
    [join(fixture, "node_modules/zedbee/dist/cli.js"), "--help"],
    { cwd: fixture, shell: false, stdin: "ignore" },
  );
  if (!result.stdout.includes("scan")) {
    throw new Error("Installed core CLI canary failed.");
  }
  console.log("Managed platform package and core tarball install passed.");
} finally {
  await rm(scratch, { recursive: true, force: true });
}
