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
    expect(readme).toContain('"temporaryReportMaxAge": "24h"');
    expect(publicDocs).toMatch(/terminalFindingLimit[^.]*default[^.]*25/i);
    expect(publicDocs).toMatch(/terminalFindingLimit[^.]*"all"/i);
    expect(publicDocs).toMatch(/temporaryReportMaxAge[^.]*default[^.]*24h/i);
    expect(reporting).toMatch(/"30m"[^.]*"24h"[^.]*"7d"/i);
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
    expect(privacy).toMatch(/operating system[^.]*remove[^.]*sooner/i);
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
      /fixed[^.]*report unavailable[^.]*alerts[^.]*twice/i,
    );
    expect(support).toMatch(
      /coding tools[^.]*complete report path[^.]*exit code 2/i,
    );
  });

  it("documents automatic-report delivery as a complete, accessible handoff", async () => {
    const [readme, reporting, privacy, support, checks] = await Promise.all([
      read("README.md"),
      read("docs/reporting.md"),
      read("docs/privacy.md"),
      read("docs/support.md"),
      read("docs/checks.md"),
    ]);
    const publicDocs = [readme, reporting, privacy, support, checks].join("\n");

    expect(readme).toContain('"agentGuidance"');
    expect(readme).toContain('"opening"');
    expect(readme).toContain('"nextStep"');
    expect(readme).toMatch(/example[^.]*illustrative/i);
    expect(readme).toMatch(/init[^.]*editable recommended guidance/i);
    expect(readme).not.toMatch(/init[^.]*text shown above/i);
    expect(publicDocs).toMatch(
      /automatic scans[^.]*always[^.]*complete versioned JSON report/i,
    );
    expect(publicDocs).toMatch(/pass[^.]*zero findings[^.]*report/i);
    expect(publicDocs).toMatch(
      /complete report path[^.]*before[^.]*final output/i,
    );
    expect(publicDocs).toMatch(
      /wide[^.]*TTY[^.]*branded[^.]*narrow[^.]*linear[^.]*ANSI-free/i,
    );
    expect(publicDocs).toMatch(/CI[^.]*TERM=dumb[^.]*screen[- ]reader/i);
    expect(publicDocs).toMatch(
      /explicit Ink[^.]*only[^.]*finding[^.]*overflows/i,
    );
    expect(publicDocs).toMatch(
      /explicit text[^.]*JSON[^.]*SARIF[^.]*no sidecar/i,
    );
    expect(publicDocs).toMatch(/25[^.]*findings only[^.]*blockers first/i);
    expect(publicDocs).toMatch(
      /disclosures[^.]*incomplete checks[^.]*warnings[^.]*never limited/i,
    );
    expect(publicDocs).toMatch(
      /opening[^.]*nextStep[^.]*independently[^.]*""/i,
    );
    expect(publicDocs).toMatch(
      /complete-report[^.]*lines[^.]*remain[^.]*blank/i,
    );
    expect(publicDocs).toMatch(
      /report failure[^.]*no[^.]*path[^.]*guidance[^.]*fixed[^.]*alerts[^.]*twice/i,
    );
    expect(publicDocs).toMatch(/REPORT UNAVAILABLE/i);
    expect(publicDocs).not.toMatch(/REPORT DELIVERY WARNING[^.]*twice/i);
    expect(publicDocs).toMatch(/all findings[^.]*canonical scan outcome/i);
    expect(publicDocs).toMatch(
      /default[^.]*automatic (?:temporary )?report[^.]*omits ordinary source/i,
    );
    expect(publicDocs).toMatch(/CLI overrides[^.]*automatic reports/i);
    expect(publicDocs).toMatch(/secret content[^.]*always redacted/i);
    expect(publicDocs).toMatch(/operating-system temporary/i);
    for (const document of [readme, reporting, privacy, support]) {
      expect(document).toMatch(
        /temporary reports[^.]*eligible for cleanup[^.]*configured age/i,
      );
      expect(document).toMatch(
        /removed[^.]*subsequent Zedbee maintenance run/i,
      );
      expect(document).toMatch(/operating system[^.]*remove[^.]*sooner/i);
      expect(document).toMatch(/not (?:an )?archive|not archival storage/i);
      expect(document).not.toMatch(/retained for at most/i);
    }
    expect(publicDocs).toMatch(
      /durable JSON[^.]*SARIF[^.]*explicit output[^.]*redirection/i,
    );
    expect(publicDocs).not.toMatch(/Windows ACL/i);
    expect(readme).toContain("PolyForm Small Business License 1.0.0");
  });

  it("documents responsive Doctor output and stable plain fallbacks", async () => {
    const readme = await read("README.md");

    expect(readme).toMatch(/Doctor uses[^.]*yellow Zedbee frame/i);
    expect(readme).toMatch(/DOCTOR` panel[^.]*wide interactive terminal/i);
    expect(readme).toMatch(
      /narrow terminal[^.]*redirected output[^.]*CI environment[^.]*plain text/i,
    );
    expect(readme).toMatch(/doctor --format text[^.]*plain/i);
    expect(readme).toMatch(/doctor --format json[^.]*ANSI-free/i);
  });

  it("documents responsive Checks output without changing its machine format", async () => {
    const readme = await read("README.md");

    expect(readme).toMatch(/Checks uses[^.]*yellow Zedbee frame/i);
    expect(readme).toMatch(/CHECKS` panel[^.]*wide interactive terminal/i);
    expect(readme).toMatch(/checks --format text[^.]*plain/i);
    expect(readme).toMatch(/checks --format json[^.]*ANSI-free/i);
  });

  it("documents the complete managed check customization contract", async () => {
    const [readme, checks, support] = await Promise.all([
      read("README.md"),
      read("docs/checks.md"),
      read("docs/support.md"),
    ]);
    const publicDocs = [readme, checks, support].join("\n");

    for (const checkId of [
      "formatting",
      "lint",
      "cyclomaticComplexity",
      "readabilityComplexity",
      "duplication",
      "reactCorrectness",
      "reactAccessibility",
    ]) {
      expect(publicDocs).toContain(`\`${checkId}\``);
    }
    for (const option of [
      "printWidth",
      "tabWidth",
      "useTabs",
      "semi",
      "singleQuote",
      "quoteProps",
      "jsxSingleQuote",
      "trailingComma",
      "bracketSpacing",
      "bracketSameLine",
      "arrowParens",
      "proseWrap",
      "endOfLine",
      "singleAttributePerLine",
    ]) {
      expect(publicDocs).toContain(`\`${option}\``);
    }
    for (const setting of [
      "max",
      "blockWorsening",
      "threshold",
      "minLines",
      "minTokens",
    ]) {
      expect(publicDocs).toContain(`\`${setting}\``);
    }
    for (const mode of ["strict", "mild", "weak"]) {
      expect(publicDocs).toContain(`\`${mode}\``);
    }
    for (const [field, defaultValue] of [
      ["printWidth", "80"],
      ["tabWidth", "2"],
      ["minLines", "5"],
      ["minTokens", "50"],
    ]) {
      expect(checks).toMatch(
        new RegExp(
          `\\|\\s*\`${field}\`\\s*\\|\\s*\`${defaultValue}\`\\s*\\|\\s*Positive safe integer\\s*\\|`,
          "iu",
        ),
      );
    }
    expect(publicDocs).toMatch(/exactly seven[^.]*configurable checks/i);
    expect(publicDocs).toMatch(/later matching override[^.]*takes precedence/i);
    expect(publicDocs).toMatch(/duplication[^.]*workspace-wide/i);
    expect(publicDocs).toMatch(/bundled rules[^.]*custom plugins/i);
    expect(publicDocs).toMatch(
      /rule options[^.]*analyzer and plugin versions pinned by the installed Zedbee release/i,
    );
    expect(publicDocs).toMatch(
      /`zedbee checks`[^.]*primary managed engine summary/i,
    );
    expect(publicDocs).not.toMatch(
      /versions printed by `zedbee checks`|versions appear in `zedbee checks` output/i,
    );
    expect(publicDocs).toMatch(/does not load[^.]*native analyzer config/i);
    expect(publicDocs).toMatch(
      /native configs[^.]*different Zedbee results[^.]*not loaded/i,
    );
    expect(publicDocs).toMatch(
      /`zedbee checks`[^.]*effective settings[^.]*overrides/i,
    );
  });
});
