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

  it("documents Node-native security engines, support, licensing, and privacy", async () => {
    const [readme, privacy, licensing, support] = await Promise.all([
      read("README.md"),
      read("docs/privacy.md"),
      read("docs/commercial-licensing.md"),
      read("docs/support.md"),
    ]);
    expect(readme).toContain("Secretlint");
    expect(readme).toContain("Zedbee OSV API client");
    expect(privacy).toContain("api.osv.dev");
    for (const category of [
      "package names",
      "exact versions",
      "ecosystem identifier",
    ]) {
      expect(privacy).toContain(category);
    }
    expect(privacy).toMatch(/source code and file hashes are not sent/i);
    expect(privacy).not.toContain("api.deps.dev");
    expect(licensing).toContain("Secretlint 13.0.4");
    expect(licensing).toContain("MIT");
    expect(licensing).toMatch(/OSV API client[^.]*Zedbee's own code/i);
    expect(licensing).toContain("PolyForm Small Business");
    for (const lockfile of [
      "package-lock.json",
      "npm-shrinkwrap.json",
      "pnpm-lock.yaml",
      "yarn.lock",
      "bun.lock",
    ]) {
      expect(support).toContain(`\`${lockfile}\``);
    }
    expect(support).toMatch(/bun\.lockb[^.]*not supported/i);
  });

  it("keeps current coverage free of roadmap wording", async () => {
    const readme = await read("README.md");
    expect(readme).not.toMatch(/planned check|future managed check/i);
    expect(readme).toContain("Node.js 22.13.0 or newer");
  });

  it("documents staged React version calibration", async () => {
    const reactAnalysis = await read("docs/react-analysis.md");
    expect(reactAnalysis).toContain("staged package.json");
    expect(reactAnalysis).toContain("supported staged lockfile");
    expect(reactAnalysis).toContain("never loads project node_modules");
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

  it("documents complete SARIF export behavior for enterprise ingestion", async () => {
    const [readme, reporting, support, privacy] = await Promise.all([
      read("README.md"),
      read("docs/reporting.md"),
      read("docs/support.md"),
      read("docs/privacy.md"),
    ]);

    expect(readme).toContain("--format sarif");
    expect(readme).toContain("docs/reporting.md");
    expect(reporting).toContain("--format sarif");
    expect(reporting).toContain("SARIF 2.1.0");
    expect(reporting).toMatch(/complete report/i);
    expect(reporting).toMatch(/normal exit status/i);
    expect(support).toMatch(/SARIF[^.]*complete/i);
    expect(privacy).toMatch(/SARIF[^.]*source-excerpt policy/i);
  });

  it("documents source defaults, secret redaction, and safe cleanup disclosure", async () => {
    const privacy = await read("docs/privacy.md");
    expect(privacy).toMatch(/interactive Ink[^.]*source excerpts[^.]*default/i);
    expect(privacy).toMatch(
      /redirected text, JSON, and SARIF[^.]*default off/i,
    );
    expect(privacy).toMatch(/secrets are always redacted/i);
    expect(privacy).toMatch(
      /cleanup failure[^.]*disclose one validated Zedbee temporary directory/i,
    );
  });

  it("documents bounded automatic terminal reports and their complete-report contract", async () => {
    const [readme, reporting, privacy, support] = await Promise.all([
      read("README.md"),
      read("docs/reporting.md"),
      read("docs/privacy.md"),
      read("docs/support.md"),
    ]);
    const publicDocs = [readme, reporting, privacy, support].join("\n");

    expect(readme).toContain('"terminalFindingLimit": 25');
    expect(readme).toContain('"temporaryReportRetention": 5');
    expect(publicDocs).toMatch(/terminalFindingLimit[^.]*default[^.]*25/i);
    expect(publicDocs).toMatch(/terminalFindingLimit[^.]*"all"/i);
    expect(publicDocs).toMatch(
      /temporaryReportRetention[^.]*default[^.]*5 subsequent runs/i,
    );
    expect(reporting).toMatch(
      /explicit text \(`--format text`\), JSON \(`--format json`\), and SARIF \(`--format sarif`\)[^.]*complete/i,
    );
    expect(reporting).toMatch(
      /path[^.]*printed only after[^.]*complete report[^.]*exists/i,
    );
    expect(reporting).toMatch(/fixing only[^.]*preview[^.]*insufficient/i);
    expect(reporting).toMatch(
      /explicit `?--format ink`?[^.]*bounded[^.]*preview/i,
    );
    expect(privacy).toMatch(/protected operating-system temporary storage/i);
    expect(privacy).toMatch(/operating system[^.]*delete[^.]*early/i);
    expect(privacy).toMatch(
      /owner-only POSIX permissions[^.]*where supported/i,
    );
    expect(privacy).toMatch(/user-specific OS temporary[^.]*other platforms/i);
    expect(privacy).not.toMatch(
      /each managed directory is restricted to the current OS user/i,
    );
    expect(privacy).toMatch(
      /interactive[^.]*source excerpts[^.]*disk[^.]*source-excerpt policy/i,
    );
    expect(support).toMatch(/cleanup and write warnings[^.]*non-blocking/i);
    expect(support).toMatch(
      /write failure[^.]*restores[^.]*full terminal output/i,
    );
    expect(support).toMatch(
      /coding tools[^.]*complete report path[^.]*exit code 2/i,
    );
  });
});
