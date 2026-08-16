import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { releaseReadiness } from "../../scripts/release-check.mjs";

const root = resolve(import.meta.dirname, "../..");

async function text(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

describe("public package metadata", () => {
  it("keeps the package license and Node floor aligned with public docs", async () => {
    const packageJson = JSON.parse(await text("package.json")) as {
      license?: string;
      engines?: { node?: string };
    };
    const [readme, commercial] = await Promise.all([
      text("README.md"),
      text("docs/commercial-licensing.md"),
    ]);

    expect(packageJson.license).toBe("PolyForm-Small-Business-1.0.0");
    expect(packageJson.engines?.node).toBe(">=22.13.0");
    expect(readme).toContain("Node.js 22.13.0 or newer");
    expect(readme).toContain("PolyForm Small Business License 1.0.0");
    expect(commercial).toMatch(/separate commercial license/i);
    expect(commercial).toMatch(/not legal advice/i);
  });

  it("blocks publication until owner-supplied metadata matches a remote", () => {
    const message =
      "Release blocked: add the canonical HTTPS repository.url, homepage, and bugs.url to package.json and configure the matching Git remote.";
    expect(releaseReadiness({ name: "zedbee" }, [])).toEqual({
      ready: false,
      message,
    });
    expect(
      releaseReadiness(
        {
          repository: { url: "https://example.com/placeholder.git" },
          homepage: "https://example.com/placeholder",
          bugs: { url: "https://example.com/placeholder/issues" },
        },
        ["https://example.com/placeholder.git"],
      ),
    ).toEqual({ ready: false, message });
  });
});
