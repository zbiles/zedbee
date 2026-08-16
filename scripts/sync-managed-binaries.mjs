import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { assertOfficialManagedBinaryEntry } from "./managed-binary-source-policy.mjs";

const execFile = promisify(execFileCallback);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const officialSource = Object.freeze({
  gitleaks: {
    license:
      "https://raw.githubusercontent.com/gitleaks/gitleaks/v8.28.0/LICENSE",
    notice:
      "Gitleaks 8.28.0 is bundled under the MIT License.\nRepository: https://github.com/gitleaks/gitleaks\n",
  },
  "osv-scanner": {
    license:
      "https://raw.githubusercontent.com/google/osv-scanner/v2.4.0/LICENSE",
    notice:
      "OSV-Scanner 2.4.0 is bundled under the Apache License 2.0.\nRepository: https://github.com/google/osv-scanner\n",
  },
});

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message) {
  throw new Error(`Managed binary synchronization failed: ${message}`);
}

async function download(url) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok || !response.url.startsWith("https://")) {
    fail(`download rejected (${response.status})`);
  }
  return Buffer.from(await response.arrayBuffer());
}

function assertChecksum(value, expected, label) {
  if (sha256(value) !== expected) fail(`${label} checksum mismatch`);
}

function checksumFor(checksumText, assetName) {
  for (const line of checksumText.split(/\r?\n/u)) {
    const match = /^([a-f0-9]{64})\s+\*?(.+)$/u.exec(line.trim());
    if (match?.[2] === assetName) return match[1];
  }
  fail("upstream checksum file omitted the selected asset");
}

function safeArchiveEntries(output) {
  const entries = output.split(/\r?\n/u).filter(Boolean);
  for (const entry of entries) {
    const portable = entry.replaceAll("\\", "/");
    if (
      portable.startsWith("/") ||
      /^[A-Za-z]:\//u.test(portable) ||
      portable.split("/").includes("..")
    ) {
      fail("archive contains an unsafe path");
    }
  }
  return entries;
}

async function extract(entry, archivePath) {
  if (entry.assetFormat === "binary") return readFile(archivePath);
  const executableName =
    entry.platform === "win32" ? "gitleaks.exe" : "gitleaks";
  if (entry.assetFormat === "tar.gz") {
    const listed = await execFile("tar", ["-tzf", archivePath], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    if (!safeArchiveEntries(listed.stdout).includes(executableName)) {
      fail("archive omitted executable");
    }
    const verbose = await execFile("tar", ["-tvzf", archivePath], {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    const executableLine = verbose.stdout
      .split(/\r?\n/u)
      .find((line) => line.trimEnd().endsWith(` ${executableName}`));
    if (executableLine === undefined || executableLine[0] !== "-") {
      fail("executable archive entry is not a regular file");
    }
    const extracted = await execFile(
      "tar",
      ["-xOzf", archivePath, executableName],
      {
        encoding: "buffer",
        maxBuffer: 128 * 1024 * 1024,
      },
    );
    return extracted.stdout;
  }
  const command = process.platform === "win32" ? "tar" : "unzip";
  const listArgs =
    process.platform === "win32" ? ["-tf", archivePath] : ["-Z1", archivePath];
  const listed = await execFile(command, listArgs, {
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });
  if (!safeArchiveEntries(listed.stdout).includes(executableName)) {
    fail("archive omitted executable");
  }
  const extractArgs =
    process.platform === "win32"
      ? ["-xOf", archivePath, executableName]
      : ["-p", archivePath, executableName];
  const extracted = await execFile(command, extractArgs, {
    encoding: "buffer",
    maxBuffer: 128 * 1024 * 1024,
  });
  return extracted.stdout;
}

const engine = argument("--engine");
const version = argument("--version");
const platform = argument("--platform");
const arch = argument("--arch");
if (!(engine in officialSource) || version === undefined) {
  fail("use --engine gitleaks|osv-scanner and --version <pinned-version>");
}
const central = JSON.parse(
  await readFile(
    resolve(root, "packages/managed-binary/manifest.json"),
    "utf8",
  ),
);
const selected = central.entries.filter(
  (entry) =>
    entry.engine === engine &&
    entry.version === version &&
    (platform === undefined || entry.platform === platform) &&
    (arch === undefined || entry.arch === arch),
);
if (selected.length === 0) fail("no locked release matches the request");
for (const entry of selected) {
  try {
    assertOfficialManagedBinaryEntry(entry);
  } catch {
    fail("managed source does not match the reviewed upstream release");
  }
}

const scratch = await mkdtemp(join(tmpdir(), "zedbee-managed-binaries-"));
try {
  for (const entry of selected) {
    const checksumBytes = await download(entry.checksumUrl);
    assertChecksum(checksumBytes, entry.checksumSha256, "checksum file");
    const assetBytes = await download(entry.assetUrl);
    const assetName = basename(new URL(entry.assetUrl).pathname);
    const published = checksumFor(checksumBytes.toString("utf8"), assetName);
    if (published !== entry.assetSha256)
      fail("locked asset checksum differs from upstream");
    assertChecksum(assetBytes, entry.assetSha256, "release asset");

    const archivePath = join(scratch, assetName);
    await writeFile(archivePath, assetBytes, { flag: "wx" });
    const executable = await extract(entry, archivePath);
    assertChecksum(executable, entry.executableSha256, "executable");

    const source = officialSource[entry.engine];
    const license = await download(source.license);
    const config =
      entry.configUrl === undefined
        ? undefined
        : await download(entry.configUrl);
    if (config !== undefined)
      assertChecksum(config, entry.configSha256, "rule config");

    const packageDirectory = resolve(
      root,
      "packages",
      entry.packageName.replace("@zedbee/", ""),
    );
    const stage = join(scratch, entry.packageName.replace("@zedbee/", ""));
    await mkdir(join(stage, "vendor"), { recursive: true });
    await writeFile(join(stage, basename(entry.executablePath)), executable, {
      flag: "wx",
    });
    await chmod(join(stage, basename(entry.executablePath)), 0o755);
    if (config !== undefined)
      await writeFile(join(stage, "gitleaks.toml"), config, { flag: "wx" });
    await writeFile(join(stage, "LICENSE"), license, { flag: "wx" });
    await writeFile(join(stage, "THIRD_PARTY_NOTICES.md"), source.notice, {
      flag: "wx",
    });

    await mkdir(resolve(packageDirectory, "vendor"), { recursive: true });
    await rename(
      join(stage, basename(entry.executablePath)),
      resolve(packageDirectory, entry.executablePath),
    );
    if (config !== undefined) {
      await rename(
        join(stage, "gitleaks.toml"),
        resolve(packageDirectory, entry.configPath),
      );
    }
    await copyFile(
      join(stage, "LICENSE"),
      resolve(packageDirectory, entry.licensePath),
    );
    await copyFile(
      join(stage, "THIRD_PARTY_NOTICES.md"),
      resolve(packageDirectory, entry.noticePath),
    );
    console.log(`Synchronized ${entry.packageName}.`);
  }
} finally {
  await rm(scratch, { recursive: true, force: true });
}
