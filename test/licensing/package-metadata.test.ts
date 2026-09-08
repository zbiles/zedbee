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
      version: "0.1.0",
      repository: {
        type: "git",
        url: "https://github.com/zbiles/Zedbee.git",
      },
      homepage: "https://github.com/zbiles/Zedbee#readme",
      bugs: { url: "https://github.com/zbiles/Zedbee/issues" },
      publishConfig: {
        access: "public",
        registry: "https://registry.npmjs.org/",
      },
    });
    expect(packageJson.engines?.node).toBe(NODE_ENGINE_RANGE);
    expect(packageLock.packages?.[""]?.engines?.node).toBe(NODE_ENGINE_RANGE);
    expect(readme).toContain(
      "Node.js versions matching `^22.17.0 || >=24.2.0`",
    );
    expect(support).toContain(
      "Node.js versions matching `^22.17.0 || >=24.2.0`",
    );
    expect(readme).toContain("PolyForm Small Business License 1.0.0");
    expect(commercial).toMatch(/separate commercial license/i);
    expect(commercial).toMatch(/not legal advice/i);
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
