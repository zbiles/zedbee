import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import {
  downloadCli,
  MAX_RELEASE_BYTES,
} from "../../plugins/swarm/scripts/download-cli.mjs";
import {
  checkPlugin,
  preparePlugin,
  PLUGIN_FILES,
} from "../../scripts/prepare-plugin.mjs";

const temporary: string[] = [];
async function temp() {
  const root = await mkdtemp(join(tmpdir(), "zedbee-plugin-test-"));
  temporary.push(root);
  return root;
}
afterEach(async () => {
  for (const root of temporary.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await temp();
  await cp(resolve("plugins"), join(root, "plugins"), { recursive: true });
  await cp(resolve("LICENSE"), join(root, "LICENSE"));
  return root;
}
const bytes = Buffer.from("verified release bytes");
const release = {
  version: "0.1.0-beta.12",
  url: "https://registry.npmjs.org/zedbee/-/zedbee-0.1.0-beta.12.tgz",
  sha256: createHash("sha256").update(bytes).digest("hex"),
};
describe("official Swarm plugin package", () => {
  it("creates a complete allowlisted ZIP independently of unrelated repository files", async () => {
    const root = await fixture();
    const output = await temp();
    await writeFile(
      join(root, "plugins/swarm/private.env"),
      "SECRET=never-package",
    );
    const result = await preparePlugin(output, root);
    const entries = await execa("unzip", ["-Z1", result.archive]);
    expect(entries.stdout.split("\n").sort()).toEqual([...PLUGIN_FILES].sort());
    const unpacked = await temp();
    await execa("unzip", ["-q", result.archive, "-d", unpacked]);
    const metadata = JSON.parse(
      await readFile(join(unpacked, "plugin.json"), "utf8"),
    );
    const claude = JSON.parse(
      await readFile(join(unpacked, ".claude-plugin/plugin.json"), "utf8"),
    );
    expect(metadata.extensions["com.openai"].requires_local_executor).toBe(
      true,
    );
    expect(claude).toMatchObject({
      name: metadata.name,
      version: metadata.version,
      displayName: "Swarm",
    });
    expect(await readdir(join(unpacked, "skills"))).toEqual([
      "doctor",
      "fix",
      "scan",
    ]);
    expect(metadata.extensions["com.openai"].onboardingSkill).toBe(
      "./skills/scan/SKILL.md",
    );
    for (const reference of ["setup.md", "scan.md"])
      expect(
        await readFile(join(unpacked, "references", reference), "utf8"),
      ).not.toBe("");
    // Every workflow link must survive extraction without access to the checkout.
    for (const file of PLUGIN_FILES.filter((path) => path.endsWith(".md"))) {
      const contents = await readFile(join(unpacked, file), "utf8");
      for (const match of contents.matchAll(/\]\(([^)]+)\)/gu)) {
        const target = match[1]!;
        if (/^[a-z]+:/u.test(target) || target.startsWith("#")) continue;
        const destination = resolve(unpacked, file, "..", target);
        expect(destination.startsWith(`${unpacked}${sep}`)).toBe(true);
        expect(await readFile(destination, "utf8")).not.toBe("");
      }
    }
    expect(await readFile(join(unpacked, "LICENSE"), "utf8")).toBe(
      await readFile("LICENSE", "utf8"),
    );
    await expect(preparePlugin(output, root)).rejects.toThrow(/already exists/);
  });
  it("rejects stale generated metadata and can regenerate it", async () => {
    const root = await fixture();
    const path = join(root, "plugins/swarm/plugin.json");
    const metadata = JSON.parse(await readFile(path, "utf8"));
    metadata.version = "0.2.0";
    await writeFile(path, JSON.stringify(metadata));
    await expect(checkPlugin(root)).rejects.toThrow(/stale/);
    await checkPlugin(root, { write: true });
    await expect(checkPlugin(root)).resolves.toMatchObject({
      version: "0.2.0",
    });
  });
  it("refuses a package file that points outside the plugin", async () => {
    const root = await fixture();
    const path = join(root, "plugins/swarm/README.md");
    await rm(path);
    await symlink(join(root, "LICENSE"), path);
    await expect(checkPlugin(root)).rejects.toThrow(/Unsafe/);
  });
  it("refuses symlinked generated metadata", async () => {
    const root = await fixture();
    const path = join(root, "plugins/swarm/.claude-plugin/plugin.json");
    await rm(path);
    await symlink(join(root, "LICENSE"), path);
    await expect(checkPlugin(root, { write: true })).rejects.toThrow(/Unsafe/);
  });
});
describe("verified CLI download", () => {
  it("returns only an exact checksum-verified private tarball", async () => {
    const root = await temp();
    const result = await downloadCli({
      release,
      temporaryRoot: root,
      fetchRelease: async (url: string) => {
        expect(url).toBe(release.url);
        return new Response(bytes);
      },
    });
    expect(await readFile(result.tarball)).toEqual(bytes);
    expect(result.version).toBe(release.version);
    expect(result.package).toBe(`zedbee@${release.version}`);
    expect(result.url).toBe(release.url);
    expect(result.integrity).toBe(
      `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    );
  });
  it("discards a corrupt or substituted release", async () => {
    const root = await temp();
    await expect(
      downloadCli({
        release,
        temporaryRoot: root,
        fetchRelease: async () => new Response("modified"),
      }),
    ).rejects.toThrow(/checksum/);
    expect(await readdir(root)).toEqual([]);
  });
  it.each([
    "https://example.invalid/tool.tgz",
    "https://github.com/zbiles/zedbee/releases/download/v0.1.0-beta.12/zedbee-0.1.0-beta.12.tgz",
  ])("rejects nonregistry release URL %s before fetching", async (url) => {
    const root = await temp();
    await expect(
      downloadCli({
        release: { ...release, url },
        temporaryRoot: root,
        fetchRelease: async () => {
          throw new Error("must not fetch");
        },
      }),
    ).rejects.toThrow(/Invalid pinned/);
    expect(await readdir(root)).toEqual([]);
  });
  it("rejects an excessive announced body before retaining any artifact", async () => {
    const root = await temp();
    await expect(
      downloadCli({
        release,
        temporaryRoot: root,
        fetchRelease: async () =>
          new Response(bytes, {
            headers: { "content-length": String(MAX_RELEASE_BYTES + 1) },
          }),
      }),
    ).rejects.toThrow(/too large/);
    expect(await readdir(root)).toEqual([]);
  });
  it("removes a partial artifact after a streaming failure", async () => {
    const root = await temp();
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
      },
      pull(controller) {
        controller.error(new Error("stream failed"));
      },
    });
    await expect(
      downloadCli({
        release,
        temporaryRoot: root,
        fetchRelease: async () => new Response(body),
      }),
    ).rejects.toThrow(/stream failed/);
    expect(await readdir(root)).toEqual([]);
  });
});
