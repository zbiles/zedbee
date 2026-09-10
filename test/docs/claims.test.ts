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
    const [reference, privacy, licensing, support] = await Promise.all([
      read("docs/cli-reference.md"),
      read("docs/privacy.md"),
      read("docs/commercial-licensing.md"),
      read("docs/support.md"),
    ]);
    expect(reference).toContain("Secretlint");
    expect(reference).toContain("Zedbee OSV API client");
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
    const manifest = JSON.parse(await read("package.json"));
    expect(licensing).toContain(
      `Secretlint ${manifest.dependencies["@secretlint/core"]}`,
    );
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
    expect(readme).toContain(
      "Node.js versions matching `^22.17.0 || >=24.2.0`",
    );
  });

  it("documents selected-snapshot React version calibration", async () => {
    const reactAnalysis = await read("docs/react-analysis.md");
    expect(reactAnalysis).toContain("selected snapshot's `package.json`");
    expect(reactAnalysis).toMatch(/supported lockfile in the same\s+snapshot/u);
    expect(reactAnalysis).toContain("selected snapshot");
    expect(reactAnalysis).toMatch(/never loads project\s+node_modules/u);
  });

  it("publishes runnable source-excerpt and report redirection commands", async () => {
    const reference = await read("docs/cli-reference.md");
    for (const command of [
      "npx zedbee scan --include-source",
      "npx zedbee scan --no-source",
      "npx zedbee scan --format text --include-source > zedbee-report-with-source.txt",
    ]) {
      expect(reference).toContain(command);
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
    const [reference, reporting, privacy, support] = await Promise.all([
      read("docs/cli-reference.md"),
      read("docs/reporting.md"),
      read("docs/privacy.md"),
      read("docs/support.md"),
    ]);
    const publicDocs = [reference, reporting, privacy, support].join("\n");

    expect(reference).toContain('"terminalFindingLimit": 25');
    expect(reference).toContain('"temporaryReportMaxAge": "24h"');
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
    const [reference, reporting, privacy, support, checks] = await Promise.all([
      read("docs/cli-reference.md"),
      read("docs/reporting.md"),
      read("docs/privacy.md"),
      read("docs/support.md"),
      read("docs/checks.md"),
    ]);
    const publicDocs = [reference, reporting, privacy, support, checks].join(
      "\n",
    );

    expect(reference).toContain('"agentGuidance"');
    expect(reference).toContain('"opening"');
    expect(reference).toContain('"nextStep"');
    expect(reference).toMatch(/example[^.]*illustrative/i);
    expect(reference).toMatch(/init[^.]*editable recommended guidance/i);
    expect(reference).not.toMatch(/init[^.]*text shown above/i);
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
    for (const document of [reference, reporting, privacy, support]) {
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
    expect(await read("README.md")).toContain(
      "PolyForm Small Business License 1.0.0",
    );
  });

  it("documents responsive Doctor output and stable plain fallbacks", async () => {
    const reference = await read("docs/cli-reference.md");

    expect(reference).toMatch(/Doctor uses[^.]*yellow Zedbee frame/i);
    expect(reference).toMatch(/DOCTOR` panel[^.]*wide interactive terminal/i);
    expect(reference).toMatch(
      /narrow terminal[^.]*redirected output[^.]*CI environment[^.]*plain text/i,
    );
    expect(reference).toMatch(/doctor --format text[^.]*plain/i);
    expect(reference).toMatch(/doctor --format json[^.]*ANSI-free/i);
  });

  it("documents responsive Checks output without changing its machine format", async () => {
    const reference = await read("docs/cli-reference.md");

    expect(reference).toMatch(/Checks uses[^.]*yellow Zedbee frame/i);
    expect(reference).toMatch(/CHECKS` panel[^.]*wide interactive terminal/i);
    expect(reference).toMatch(/checks --format text[^.]*plain/i);
    expect(reference).toMatch(/checks --format json[^.]*ANSI-free/i);
  });

  it("documents the complete managed check customization contract", async () => {
    const [reference, checks, support] = await Promise.all([
      read("docs/cli-reference.md"),
      read("docs/checks.md"),
      read("docs/support.md"),
    ]);
    const publicDocs = [reference, checks, support].join("\n");

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

  it("documents the complete managed-fix contract without promising index mutation", async () => {
    const [guide, readme, checks, reporting, privacy, support] =
      await Promise.all([
        read("docs/managed-fixes.md"),
        read("README.md"),
        read("docs/checks.md"),
        read("docs/reporting.md"),
        read("docs/privacy.md"),
        read("docs/support.md"),
      ]);
    const publicDocs = [
      guide,
      readme,
      checks,
      reporting,
      privacy,
      support,
    ].join("\n");

    for (const command of [
      "npx zedbee fix",
      "npx zedbee fix formatting",
      "npx zedbee fix lint",
      "npx zedbee fix reactCorrectness",
      "npx zedbee fix --yes --format json",
    ]) {
      expect(guide).toContain(command);
    }
    expect(guide).toMatch(/rescans?[^.]*current staged code/i);
    expect(guide).toMatch(/bare[^.]*all three[^.]*fixable checks/i);
    expect(guide).toMatch(/named selector[^.]*only[^.]*selected check/i);
    expect(guide).toMatch(/blocking[^.]*warning[^.]*included/i);
    expect(guide).toMatch(
      /Prettier[^.]*complete current working file[^.]*unstaged work/i,
    );
    expect(guide).toMatch(
      /ESLint[^.]*React correctness[^.]*exact[^.]*reported official fixes/i,
    );
    expect(guide).toMatch(/suggestions[^.]*remain manual/i);
    expect(guide).toMatch(/unsupported checks[^.]*remain manual/i);
    expect(guide).toMatch(/exact fixes[^.]*before[^.]*formatting/i);
    expect(guide).toMatch(/interactive[^.]*preview[^.]*confirmation/i);
    expect(guide).toMatch(/`--yes`[^.]*automation approval flag/i);
    expect(guide).toMatch(
      /partial completion[^.]*safe files[^.]*skipped fixes[^.]*exit(?:s| status)? 1/i,
    );
    expect(guide).toMatch(/never stages or\s+commits/i);
    expect(guide).toMatch(/schema version 1[^.]*no replayable patch/i);

    expect(readme).toContain("docs/managed-fixes.md");
    expect(readme).toMatch(/`zedbee fix`[^.]*current staged code/i);
    expect(readme).toMatch(/never stages or\s+commits/i);
    expect(checks).toMatch(/managed fix[^.]*exact reported official fixes/i);
    expect(checks).toMatch(/suggestions[^.]*manual/i);
    expect(reporting).toMatch(
      /managed fix[^.]*schema version 1[^.]*source-free[^.]*no replayable patch/i,
    );
    expect(privacy).toMatch(/managed fix[^.]*source-free[^.]*no source text/i);
    expect(support).toMatch(
      /managed fix[^.]*conflict[^.]*partial progress[^.]*nonzero/i,
    );
    expect(publicDocs).toMatch(/review[^.]*stage[^.]*rescan/i);
  });

  it("keeps narrow TTY fix previews framed, interactive, and scrollable", async () => {
    const guide = await read("docs/managed-fixes.md");

    expect(guide).toMatch(
      /narrow\s+TTY[^.]*framed[^.]*interactive[^.]*scrollable[^.]*Apply[^.]*Cancel/i,
    );
    expect(guide).toMatch(
      /non-TTY[^.]*without `--yes`[^.]*linear[^.]*does not write/i,
    );
    expect(guide).not.toMatch(/narrow terminal[^.]*linear preview/i);
  });

  it("publishes a structurally consistent managed-fix JSON example", async () => {
    const guide = await read("docs/managed-fixes.md");
    const fenced = guide.match(
      /## Preview and JSON[\s\S]*?```json\r?\n([\s\S]*?)\r?\n```/u,
    );
    expect(fenced).not.toBeNull();
    const example = JSON.parse(fenced![1]!) as {
      selectedChecks: string[];
      summary: {
        fixes: number;
        files: number;
        blocking: number;
        warnings: number;
        skipped: number;
      };
      files: Array<{ path: string; fixes: number }>;
      items: Array<{
        checkId: string;
        file: string;
        findingIds: string[];
        fixes: number;
        blocking: number;
        warnings: number;
      }>;
    };

    expect(example.summary.files).toBe(example.files.length);
    expect(example.summary.fixes).toBe(
      example.items.reduce((total, item) => total + item.fixes, 0),
    );
    expect(example.summary.blocking).toBe(
      example.items.reduce((total, item) => total + item.blocking, 0),
    );
    expect(example.summary.warnings).toBe(
      example.items.reduce((total, item) => total + item.warnings, 0),
    );
    expect(example.summary.skipped).toBe(0);
    expect(example.files.reduce((total, file) => total + file.fixes, 0)).toBe(
      example.summary.fixes,
    );
    for (const file of example.files) {
      expect(file.fixes).toBe(
        example.items
          .filter((item) => item.file === file.path)
          .reduce((total, item) => total + item.fixes, 0),
      );
    }
    expect(example.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ checkId: "lint", fixes: 2 }),
        expect.objectContaining({ checkId: "formatting", fixes: 1 }),
      ]),
    );
    expect(example.summary.blocking).toBe(1);
    expect(example.summary.warnings).toBe(2);
    expect(new Set(example.items.flatMap((item) => item.findingIds)).size).toBe(
      3,
    );
    for (const item of example.items) {
      expect(example.selectedChecks).toContain(item.checkId);
      expect(example.files.map((file) => file.path)).toContain(item.file);
    }
  });
});
