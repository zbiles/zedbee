import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { execa } from "execa";
import { parse } from "yaml";
import { createGitRepository } from "../helpers/git-repository.js";

const runnerUrl = new URL(
  "../../.github/actions/scan/run.mjs",
  import.meta.url,
);
const runner = await import(runnerUrl.href);
const cliPath = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const disabled = {
  lint: "off",
  cyclomaticComplexity: "off",
  readabilityComplexity: "off",
  structuralSecurity: "off",
  reactCorrectness: "off",
  reactAccessibility: "off",
};

async function fixture(source = "export const value = 2;\n") {
  const repository = await createGitRepository("zedbee-action-repo-");
  const scratch = await mkdtemp(join(tmpdir(), "zedbee-action-runner-"));
  onTestFinished(() => rm(scratch, { recursive: true, force: true }));
  await repository.write(
    "package.json",
    '{"name":"action-fixture","private":true}',
  );
  await repository.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "fast",
      checks: disabled,
      reporting: { sourceExcerpts: "always" },
    }),
  );
  await repository.write("value.js", "export const value = 1;\n");
  await repository.commitAll("base");
  const base = (await repository.git(["rev-parse", "HEAD"])).stdout;
  await repository.write("value.js", source);
  await repository.commitAll("head");
  const head = (await repository.git(["rev-parse", "HEAD"])).stdout;
  const eventPath = join(scratch, "event.json");
  await writeFile(
    eventPath,
    JSON.stringify({ pull_request: { base: { sha: base } } }),
  );
  const env: Record<string, string | undefined> = {
    ...process.env,
    ZEDBEE_TELEMETRY_DISABLED: "1",
    RUNNER_TEMP: scratch,
    GITHUB_WORKSPACE: repository.root,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_OUTPUT: join(scratch, "output"),
    GITHUB_STEP_SUMMARY: join(scratch, "summary"),
    GITHUB_SERVER_URL: "https://github.com",
    GITHUB_REPOSITORY: "example/project",
    GITHUB_RUN_ID: "123",
    INPUT_VERSION: "0.1.0-beta.12",
    INPUT_BASE_REF: "",
    INPUT_REPORT_FORMAT: "sarif",
    INPUT_TRUST_PROJECT_PRETTIER: "false",
  };
  const run = (install = async () => cliPath) =>
    runner.runAction({ env, install });
  return { repository, scratch, base, head, eventPath, env, run };
}

it.each(["sarif", "json"])(
  "preserves a complete passing %s report and source-free summary",
  async (format) => {
    const f = await fixture();
    f.env.INPUT_REPORT_FORMAT = format;
    const result = await f.run();
    expect(result).toMatchObject({
      exitCode: 0,
      outcome: "pass",
      findings: 0,
      incomplete: 0,
    });
    const report = JSON.parse(await readFile(result.reportPath, "utf8"));
    expect(
      format === "sarif" ? report.runs[0].invocations[0].properties : report,
    ).toMatchObject({
      outcome: "pass",
      exitCode: 0,
      mode: "base",
      target: f.head,
      requestedBase: f.base,
    });
    expect(relative(f.scratch, result.reportPath)).not.toMatch(/^\.\./);
    if (process.platform !== "win32")
      expect((await stat(result.reportPath)).mode & 0o777).toBe(0o600);
    const summary = await readFile(f.env.GITHUB_STEP_SUMMARY!, "utf8");
    expect(summary).toContain("Pass");
    expect(summary).toContain("0 findings");
    expect(summary).toContain("0 incomplete");
    expect(summary).toContain(
      "https://github.com/example/project/actions/runs/123#artifacts",
    );
    expect(await readFile(f.env.GITHUB_OUTPUT!, "utf8")).toContain(
      `report-path=${result.reportPath}\nexit-code=0\noutcome=pass\n`,
    );
  },
);

it.each(["sarif", "json"])(
  "retains a complete blocked %s artifact without leaking source into summary",
  async (format) => {
    const f = await fixture("export const PRIVATE_SOURCE_MARKER={value:2}\n");
    f.env.INPUT_REPORT_FORMAT = format;
    const result = await f.run();
    expect(result).toMatchObject({
      exitCode: 1,
      outcome: "blocked",
      incomplete: 0,
    });
    expect(result.findings).toBeGreaterThan(0);
    const reportText = await readFile(result.reportPath, "utf8");
    const report = JSON.parse(reportText);
    expect(
      format === "sarif" ? report.runs[0].invocations[0].properties : report,
    ).toMatchObject({ outcome: "blocked", exitCode: 1 });
    expect(reportText).not.toContain("PRIVATE_SOURCE_MARKER");
    const summary = await readFile(f.env.GITHUB_STEP_SUMMARY!, "utf8");
    expect(summary).toContain("Blocked");
    expect(summary).not.toContain("PRIVATE_SOURCE_MARKER");
    expect(await readFile(f.env.GITHUB_OUTPUT!, "utf8")).toContain(
      "exit-code=1",
    );
  },
);

it.each(["sarif", "json"])(
  "retains a complete incomplete %s artifact after a scanner error",
  async (format) => {
    const f = await fixture("export const invalid = ;\n");
    f.env.INPUT_REPORT_FORMAT = format;
    const result = await f.run();
    expect(result).toMatchObject({ exitCode: 2, outcome: "incomplete" });
    expect(result.incomplete).toBeGreaterThan(0);
    const report = JSON.parse(await readFile(result.reportPath, "utf8"));
    expect(
      format === "sarif" ? report.runs[0].invocations[0].properties : report,
    ).toMatchObject({ outcome: "incomplete", exitCode: 2 });
    expect(await readFile(f.env.GITHUB_STEP_SUMMARY!, "utf8")).toContain(
      "Incomplete",
    );
    expect(await readFile(f.env.GITHUB_OUTPUT!, "utf8")).toContain(
      `report-path=${result.reportPath}\nexit-code=2\noutcome=incomplete\n`,
    );
  },
);

it("allows an explicit base ref without reading an unrelated malformed event", async () => {
  const f = await fixture();
  f.env.INPUT_BASE_REF = f.base;
  await writeFile(f.eventPath, "malformed");
  expect(await f.run()).toMatchObject({ exitCode: 0, outcome: "pass" });
});

it.each([
  ["INPUT_VERSION", "1.2.3\n"],
  ["INPUT_BASE_REF", "main\n"],
  ["INPUT_VERSION", "latest"],
  ["INPUT_VERSION", "^1.2.3"],
  ["INPUT_VERSION", "1.2.3;touch injected"],
  ["INPUT_VERSION", "1.2.3-01"],
  ["INPUT_BASE_REF", "--output=/tmp/injected"],
  ["INPUT_BASE_REF", "main\nexit-code=0"],
  ["INPUT_BASE_REF", "$(touch injected)"],
  ["INPUT_BASE_REF", "../../outside"],
  ["INPUT_REPORT_FORMAT", "html"],
  ["INPUT_REPORT_FORMAT", "../../report"],
  ["INPUT_TRUST_PROJECT_PRETTIER", "yes"],
])(
  "fails closed on invalid %s input without executing shell expressions",
  async (key, value) => {
    const f = await fixture();
    f.env[key!] = value;
    const result = await f.run();
    expect(result).toMatchObject({
      exitCode: 2,
      outcome: "incomplete",
      reportPath: "",
    });
    const summary = await readFile(f.env.GITHUB_STEP_SUMMARY!, "utf8");
    expect(summary).toContain("Incomplete");
    expect(summary).not.toContain(value);
    await expect(stat(join(f.repository.root, "injected"))).rejects.toThrow();
  },
);

it.each([
  "malformed JSON",
  "{}",
  '{"pull_request":{"base":{"sha":"main;touch injected"}}}',
])("fails closed for an unusable PR event: %s", async (event) => {
  const f = await fixture();
  await writeFile(f.eventPath, event);
  expect(await f.run()).toMatchObject({
    exitCode: 2,
    outcome: "incomplete",
    reportPath: "",
  });
  expect(await readFile(f.env.GITHUB_STEP_SUMMARY!, "utf8")).not.toContain(
    event,
  );
});

it("fails closed on installation errors without echoing unsafe error content", async () => {
  const f = await fixture();
  const result = await f.run(async () => {
    throw new Error("<script>secret</script>\n::warning::unsafe");
  });
  expect(result).toMatchObject({
    exitCode: 2,
    outcome: "incomplete",
    reportPath: "",
  });
  const summary = await readFile(f.env.GITHUB_STEP_SUMMARY!, "utf8");
  expect(summary).toContain("Installation failed");
  expect(summary).not.toContain("secret");
});

it("keeps startup failures separate from valid SARIF", async () => {
  const f = await fixture();
  const result = await f.run(async () => join(f.scratch, "absent-cli.js"));
  expect(result).toMatchObject({ exitCode: 2, outcome: "incomplete" });
  expect(result.reportPath).toMatch(/scanner-output\.txt$/);
  expect(await readFile(f.env.GITHUB_STEP_SUMMARY!, "utf8")).toContain(
    "No complete scan report",
  );
});

it("uses committed HEAD despite a clean working tree and unrelated staged changes", async () => {
  const f = await fixture("export const committed={value:2}\n");
  await f.repository.write(
    "value.js",
    "export const committed = { value: 2 };\n",
  );
  await f.repository.git(["add", "--", "value.js"]);
  const result = await f.run();
  expect(result).toMatchObject({ exitCode: 1, outcome: "blocked" });
  expect(result.findings).toBeGreaterThan(0);
});

it("requires explicit invocation trust before executing project Prettier configuration", async () => {
  const f = await fixture();
  const marker = join(f.scratch, "executed-project-config");
  await f.repository.write(
    "package.json",
    JSON.stringify({
      name: "project-prettier",
      private: true,
      devDependencies: { prettier: "^3.0.0" },
    }),
  );
  await f.repository.write(
    ".zedbeerc.jsonc",
    JSON.stringify({
      schemaVersion: 1,
      profile: "fast",
      checks: {
        ...disabled,
        formatting: { severity: "error", engine: "project" },
      },
    }),
  );
  await f.repository.write(
    ".prettierrc.mjs",
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'executed'); export default {};\n`,
  );
  await f.repository.commitAll("project formatting");
  await f.repository.write("node_modules/.keep", "");
  await cp(
    fileURLToPath(new URL("../../node_modules/prettier", import.meta.url)),
    join(f.repository.root, "node_modules", "prettier"),
    { recursive: true },
  );
  expect(await f.run()).toMatchObject({ exitCode: 2, outcome: "incomplete" });
  await expect(stat(marker)).rejects.toThrow();
  f.env.INPUT_TRUST_PROJECT_PRETTIER = "true";
  const trusted = await f.run();
  expect([0, 1], await readFile(trusted.reportPath, "utf8")).toContain(
    trusted.exitCode,
  );
  expect(await readFile(marker, "utf8")).toBe("executed");
});

it("does not interpolate untrusted repository metadata into summary links", async () => {
  const f = await fixture();
  f.env.GITHUB_REPOSITORY = "<script>injected</script>";
  expect(await f.run()).toMatchObject({ exitCode: 0 });
  const summary = await readFile(f.env.GITHUB_STEP_SUMMARY!, "utf8");
  expect(summary).not.toContain("injected");
});

it
  .skipIf(process.platform === "win32")
  .each(["0", "1", "2", "", "$(touch injected)"])(
  "composite final step preserves scanner status %s after artifact upload",
  async (code) => {
    const action = parse(
      await readFile(
        new URL("../../.github/actions/scan/action.yml", import.meta.url),
        "utf8",
      ),
    );
    const finalStep = action.runs.steps.at(-1);
    const f = await fixture();
    const result = await execa("bash", ["-e", "-c", finalStep.run], {
      cwd: f.repository.root,
      env: { ZEDBEE_SCAN_EXIT_CODE: code },
      reject: false,
    });
    expect(result.exitCode).toBe(code === "0" ? 0 : code === "1" ? 1 : 2);
    await expect(stat(join(f.repository.root, "injected"))).rejects.toThrow();
  },
);

async function releaseFixture() {
  const root = await mkdtemp(join(tmpdir(), "zedbee-action-release-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const version = "0.1.0-beta.12";
  const filename = "zedbee-0.1.0-beta.12.tgz";
  const baseUrl =
    "https://github.com/zbiles/zedbee/releases/download/v0.1.0-beta.12";
  const tarball = Buffer.from(
    "release artifact bytes preserved exactly\u0000\u00ff",
  );
  const digest = createHash("sha256").update(tarball).digest("hex");
  const responses = new Map<string, () => Response>([
    [`${baseUrl}/${filename}`, () => new Response(tarball)],
    [`${baseUrl}/SHA256SUMS`, () => new Response(`${digest}  ${filename}\n`)],
  ]);
  const fetcher = async (url: string) =>
    responses.get(url)?.() ?? new Response("missing", { status: 404 });
  return {
    root,
    version,
    filename,
    baseUrl,
    tarball,
    digest,
    responses,
    fetcher,
  };
}

it("downloads a canonical release artifact and verifies its digest before exposing the file", async () => {
  const f = await releaseFixture();
  const path = await runner.downloadRelease(f);
  expect(await readFile(path)).toEqual(f.tarball);
  expect(relative(f.root, path)).not.toMatch(/^\.\./);
  if (process.platform !== "win32")
    expect((await stat(path)).mode & 0o777).toBe(0o600);
});

it("rejects checksum mismatch and removes the unverified tarball", async () => {
  const f = await releaseFixture();
  f.responses.set(
    `${f.baseUrl}/${f.filename}`,
    () => new Response("tampered bytes"),
  );
  await expect(runner.downloadRelease(f)).rejects.toThrow(/checksum/i);
  await expect(stat(join(f.root, f.filename))).rejects.toThrow();
});

it.each(["not a checksum", `${"0".repeat(64)}  unexpected.tgz\n`])(
  "rejects unusable release checksums: %s",
  async (checksums) => {
    const f = await releaseFixture();
    f.responses.set(`${f.baseUrl}/SHA256SUMS`, () => new Response(checksums));
    await expect(runner.downloadRelease(f)).rejects.toThrow(/checksum/i);
  },
);

it("rejects duplicate checksum entries even if one digest matches", async () => {
  const f = await releaseFixture();
  f.responses.set(
    `${f.baseUrl}/SHA256SUMS`,
    () =>
      new Response(
        `${f.digest}  ${f.filename}\n${"0".repeat(64)}  ${f.filename}\n`,
      ),
  );
  await expect(runner.downloadRelease(f)).rejects.toThrow(/checksum/i);
});

it.each(["SHA256SUMS", "zedbee-0.1.0-beta.12.tgz"])(
  "fails closed for unavailable release asset %s",
  async (asset) => {
    const f = await releaseFixture();
    f.responses.delete(`${f.baseUrl}/${asset}`);
    await expect(runner.downloadRelease(f)).rejects.toThrow(/download/i);
  },
);

it("limits checksum download size while streaming", async () => {
  const f = await releaseFixture();
  f.responses.set(
    `${f.baseUrl}/SHA256SUMS`,
    () => new Response("x".repeat(65_537)),
  );
  await expect(runner.downloadRelease(f)).rejects.toThrow(/limit/i);
});

it("bounds downloads that never respond", async () => {
  const f = await releaseFixture();
  await expect(
    runner.downloadRelease({
      ...f,
      timeoutMs: 10,
      fetcher: () => new Promise(() => {}),
    }),
  ).rejects.toThrow(/timeout|abort/i);
});

it("fails closed on release download errors without exposing remote content", async () => {
  const f = await fixture();
  const result = await runner.runAction({
    env: f.env,
    fetcher: async () => {
      throw new Error("REMOTE_SECRET_MARKER");
    },
  });
  expect(result).toMatchObject({
    exitCode: 2,
    outcome: "incomplete",
    reportPath: "",
  });
  const summary = await readFile(f.env.GITHUB_STEP_SUMMARY!, "utf8");
  expect(summary).toContain("Installation failed");
  expect(summary).not.toContain("REMOTE_SECRET_MARKER");
});

it("fails closed when the installer cannot start after a verified download", async () => {
  const f = await fixture();
  const release = await releaseFixture();
  f.env.PATH = "";
  f.env.Path = "";
  const result = await runner.runAction({
    env: f.env,
    fetcher: release.fetcher,
  });
  expect(result).toMatchObject({
    exitCode: 2,
    outcome: "incomplete",
    reportPath: "",
  });
  expect(await readFile(f.env.GITHUB_STEP_SUMMARY!, "utf8")).toContain(
    "Installation failed",
  );
});

it("enforces the tarball size cap even without a declared content length", async () => {
  const f = await releaseFixture();
  f.responses.set(`${f.baseUrl}/${f.filename}`, () => {
    let chunks = 0;
    return new Response(
      new ReadableStream({
        pull(controller) {
          if (chunks++ < 65) controller.enqueue(new Uint8Array(1024 * 1024));
          else controller.close();
        },
      }),
    );
  });
  await expect(runner.downloadRelease(f)).rejects.toThrow(/limit/i);
  await expect(stat(join(f.root, f.filename))).rejects.toThrow();
});
