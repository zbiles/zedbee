import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseReadiness } from "../../scripts/release-check.mjs";
import { NODE_ENGINE_RANGE } from "../../src/runtime/node-support.js";

const root = resolve(import.meta.dirname, "../..");

async function text(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

describe("public package metadata", () => {
  it("keeps the package license and Node support range aligned with public docs and lock metadata", async () => {
    const packageJson = JSON.parse(await text("package.json")) as {
      name?: string;
      version?: string;
      license?: string;
      engines?: { node?: string };
      repository?: { type?: string; url?: string };
      homepage?: string;
      bugs?: { url?: string };
      publishConfig?: { access?: string; registry?: string };
    };
    const [packageLock, readme, commercial, support] = await Promise.all([
      text("package-lock.json").then(
        (contents) =>
          JSON.parse(contents) as {
            packages?: { ""?: { engines?: { node?: string } } };
          },
      ),
      text("README.md"),
      text("docs/commercial-licensing.md"),
      text("docs/support.md"),
    ]);

    expect(packageJson.license).toBe("PolyForm-Small-Business-1.0.0");
    expect(packageJson).toMatchObject({
      name: "zedbee",
      version: "0.1.0-beta.1",
      repository: {
        type: "git",
        url: "https://github.com/zbiles/zedbee.git",
      },
      homepage: "https://zedbee.dev",
      bugs: { url: "https://github.com/zbiles/zedbee/issues" },
      publishConfig: {
        tag: "next",
        access: "public",
        registry: "https://registry.npmjs.org/",
      },
      contentPolicy: { class: "dual-use" },
    });
    expect(packageJson.engines?.node).toBe(NODE_ENGINE_RANGE);
    expect(packageLock.packages?.[""]?.engines?.node).toBe(NODE_ENGINE_RANGE);
    expect(readme).toContain(
      "Node.js versions matching `^22.17.0 || >=24.2.0`",
    );
    // Markdown tables escape pipes; compare the documented range as displayed.
    expect(support.replaceAll("\\|", "|")).toContain(
      "Node.js versions matching `^22.17.0 || >=24.2.0`",
    );
    expect(readme).toContain("PolyForm Small Business License 1.0.0");
    expect(commercial).toMatch(/separate commercial license/i);
    expect(commercial).toMatch(/not legal advice/i);
  });

  it("accepts the public website while keeping repository and issue links tied to the remote", async () => {
    const manifest = {
      ...JSON.parse(await text("package.json")),
      repository: { url: "https://github.com/zbiles/zedbee.git" },
      homepage: "https://zedbee.dev",
      bugs: { url: "https://github.com/zbiles/zedbee/issues" },
    };
    const remotes = ["git@github.com:zbiles/zedbee.git"];
    expect(releaseReadiness(manifest, remotes)).toEqual({ ready: true });
    expect(
      releaseReadiness(manifest, ["git@github.com:other/zedbee.git"]),
    ).toMatchObject({ ready: false });
    expect(
      releaseReadiness(
        {
          ...manifest,
          bugs: { url: "https://github.com/other/zedbee/issues" },
        },
        remotes,
      ),
    ).toMatchObject({ ready: false });
    for (const homepage of [
      "http://zedbee.dev",
      "https://zedbee.dev.evil",
      "https://user@zedbee.dev",
      "https://example.com",
    ]) {
      expect(
        releaseReadiness({ ...manifest, homepage }, remotes),
      ).toMatchObject({ ready: false });
    }
  });

  it("blocks publication until owner-supplied metadata matches a remote", () => {
    const message =
      "Release blocked: add the canonical HTTPS repository.url, homepage, and bugs.url to package.json and configure the matching Git remote.";
    expect(
      releaseReadiness(
        {
          name: "zedbee",
          version: "0.1.0",
          publishConfig: {
            access: "public",
            registry: "https://registry.npmjs.org/",
          },
        },
        [],
      ),
    ).toEqual({
      ready: false,
      message,
    });
    expect(
      releaseReadiness(
        {
          name: "zedbee",
          version: "0.1.0",
          publishConfig: {
            access: "public",
            registry: "https://registry.npmjs.org/",
          },
          repository: { url: "https://example.com/placeholder.git" },
          homepage: "https://example.com/placeholder",
          bugs: { url: "https://example.com/placeholder/issues" },
        },
        ["https://example.com/placeholder.git"],
      ),
    ).toEqual({ ready: false, message });
  });

  it.each([
    {
      name: "not-zedbee",
      version: "0.1.0",
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org/",
      },
    },
    {
      name: "zedbee",
      version: "0.0.0",
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org/",
      },
    },
    {
      name: "zedbee",
      version: "0.1.0",
      publishConfig: {
        access: "restricted",
        registry: "https://registry.npmjs.org/",
      },
    },
    {
      name: "zedbee",
      version: "0.1.0",
      publishConfig: {
        access: "public",
        registry: "https://registry.example.test/",
      },
    },
  ])("blocks unsafe public package identity: $name@$version", (manifest) => {
    expect(releaseReadiness(manifest, [])).toEqual({
      ready: false,
      message:
        "Release blocked: package name, version, access, and registry must identify the public zedbee release.",
    });
  });
});
