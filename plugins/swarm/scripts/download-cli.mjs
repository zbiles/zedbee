import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const MAX_RELEASE_BYTES = 64 * 1024 * 1024;
export async function downloadCli({
  fetchRelease = fetch,
  release,
  temporaryRoot = tmpdir(),
} = {}) {
  const metadata =
    release ??
    JSON.parse(
      await readFile(
        new URL("../references/cli-release.json", import.meta.url),
        "utf8",
      ),
    );
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(metadata.version) ||
    metadata.url !==
      `https://registry.npmjs.org/zedbee/-/zedbee-${metadata.version}.tgz` ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  )
    throw new Error("Invalid pinned CLI release.");
  const response = await fetchRelease(metadata.url, {
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok || !response.body)
    throw new Error("CLI release download failed.");
  const announcedSize = Number(response.headers.get("content-length"));
  if (announcedSize > MAX_RELEASE_BYTES) {
    await response.body.cancel();
    throw new Error("CLI release is too large.");
  }
  const directory = await mkdtemp(
    join(temporaryRoot, "zedbee-plugin-release-"),
  );
  const tarball = join(directory, `zedbee-${metadata.version}.tgz`);
  let complete = false;
  let verifiedIntegrity;
  try {
    const handle = await open(tarball, "wx", 0o600);
    try {
      const hash = createHash("sha256");
      const integrity = createHash("sha512");
      let bytes = 0;
      for await (const chunk of response.body) {
        bytes += chunk.byteLength;
        if (bytes > MAX_RELEASE_BYTES)
          throw new Error("CLI release is too large.");
        hash.update(chunk);
        integrity.update(chunk);
        await handle.writeFile(chunk);
      }
      if (hash.digest("hex") !== metadata.sha256)
        throw new Error("CLI release checksum did not match.");
      verifiedIntegrity = `sha512-${integrity.digest("base64")}`;
      await handle.sync();
    } finally {
      await handle.close();
    }
    complete = true;
    return {
      version: metadata.version,
      package: `zedbee@${metadata.version}`,
      url: metadata.url,
      integrity: verifiedIntegrity,
      tarball,
      directory,
    };
  } finally {
    if (!complete) await rm(directory, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    console.log(JSON.stringify(await downloadCli()));
  } catch {
    console.error(
      "Swarm could not obtain the verified CLI release. No unverified artifact was retained.",
    );
    process.exitCode = 2;
  }
}
