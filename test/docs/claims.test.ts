import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CHECK_IDS } from "../../src/config/schema.js";

const root = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFile(resolve(root, path), "utf8");

describe("public documentation claims", () => {
  it("documents every shipped check and its limitations", async () => {
    const checks = await read("docs/checks.md");
    for (const checkId of CHECK_IDS) {
      expect(checks).toContain(`\`${checkId}\``);
    }
    expect(checks).toMatch(/narrower than Semgrep/i);
    expect(checks).toMatch(/not Sonar Cognitive Complexity/i);
  });

  it("documents exact managed engines, licenses, platforms, and privacy", async () => {
    const [readme, privacy, licensing] = await Promise.all([
      read("README.md"),
      read("docs/privacy.md"),
      read("docs/commercial-licensing.md"),
    ]);
    expect(readme).toContain("Gitleaks");
    expect(readme).toContain("OSV-Scanner");
    expect(privacy).toContain("api.osv.dev");
    expect(privacy).toContain("api.deps.dev");
    for (const category of [
      "package names",
      "versions",
      "ecosystems",
      "supported file hashes",
    ]) {
      expect(privacy).toContain(category);
    }
    expect(licensing).toContain("Gitleaks 8.28.0");
    expect(licensing).toContain("MIT");
    expect(licensing).toContain("OSV-Scanner 2.4.0");
    expect(licensing).toContain("Apache License 2.0");
    expect(licensing).toContain("PolyForm Small Business");
  });

  it("keeps current coverage free of roadmap wording", async () => {
    const readme = await read("README.md");
    expect(readme).not.toMatch(/planned check|future managed check/i);
    expect(readme).toContain("Node.js 22.13.0 or newer");
  });

  it("publishes runnable source-excerpt and report redirection commands", async () => {
    const readme = await read("README.md");
    for (const command of [
      "npx zedbee scan --include-source",
      "npx zedbee scan --no-source",
      "npx zedbee scan --format text --include-source > zedbee-report-with-source.txt",
    ]) {
      expect(readme).toContain(command);
    }
  });

  it("documents source defaults, secret redaction, and safe cleanup disclosure", async () => {
    const privacy = await read("docs/privacy.md");
    expect(privacy).toMatch(/interactive Ink[^.]*source excerpts[^.]*default/i);
    expect(privacy).toMatch(/redirected text and JSON[^.]*default off/i);
    expect(privacy).toMatch(/secrets are always redacted/i);
    expect(privacy).toMatch(
      /cleanup failure[^.]*disclose one validated Zedbee temporary directory/i,
    );
  });
});
