import { spawn } from "node:child_process";
import {
  appendFile,
  chmod,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function exactVersion(value) {
  if (typeof value !== "string" || value.length > 128) return false;
  const identifier = "(?:0|[1-9][0-9]*)";
  const prerelease = "(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
  return new RegExp(
    `^${identifier}\\.${identifier}\\.${identifier}(?:-${prerelease}(?:\\.${prerelease})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`,
  ).test(value);
}

function safeRef(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1024 &&
    /^[A-Za-z0-9_][A-Za-z0-9_./-]*$/.test(value) &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value
      .split("/")
      .some((part) => part.startsWith(".") || part.endsWith(".lock")) &&
    !/[/.]$/.test(value)
  );
}

async function inputs(env) {
  const version = env.INPUT_VERSION;
  const format = env.INPUT_REPORT_FORMAT || "sarif";
  const trust = env.INPUT_TRUST_PROJECT_PRETTIER || "false";
  if (
    !exactVersion(version) ||
    !["sarif", "json"].includes(format) ||
    !["true", "false"].includes(trust)
  ) {
    throw new Error("Invalid Action inputs");
  }
  let base = env.INPUT_BASE_REF;
  if (!base) {
    const event = JSON.parse(await readFile(env.GITHUB_EVENT_PATH, "utf8"));
    base = event?.pull_request?.base?.sha;
    // A PR base SHA is data from the event, never an evaluated expression.
    if (
      typeof base !== "string" ||
      !/^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/.test(base)
    ) {
      throw new Error("Invalid PR event");
    }
  }
  if (!safeRef(base)) throw new Error("Invalid base ref");
  if (
    !isAbsolute(env.RUNNER_TEMP ?? "") ||
    !isAbsolute(env.GITHUB_WORKSPACE ?? "")
  ) {
    throw new Error("Invalid runner directories");
  }
  return { version, format, base, trust: trust === "true" };
}

function childEnvironment(env) {
  // Tool execution must not inherit Node preload hooks from the checked-out project.
  const result = {
    ...env,
    NODE_OPTIONS: "",
    NODE_PATH: "",
    NO_COLOR: "1",
    ZEDBEE_UPDATE_CHECK: "0",
  };
  return result;
}

function run(command, args, options) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveResult({ code, signal }));
  });
}

async function installPackage({ version, root, env }) {
  const prefix = join(root, "tool");
  await mkdir(prefix, { mode: 0o700 });
  await writeFile(
    join(prefix, "package.json"),
    '{"name":"zedbee-action-tool","private":true}\n',
    { mode: 0o600 },
  );
  const result = await run(
    "npm",
    [
      "install",
      "--prefix",
      prefix,
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "--",
      `zedbee@${version}`,
    ],
    {
      cwd: prefix,
      env: {
        ...childEnvironment(env),
        npm_config_cache: join(root, "npm-cache"),
      },
      stdio: "ignore",
    },
  );
  if (result.code !== 0) throw new Error("Installation failed");
  return join(prefix, "node_modules", "zedbee", "dist", "cli.js");
}

function reportSummary(report, format, code) {
  let outcome;
  let findings;
  let incomplete;
  let reportExitCode;
  if (format === "sarif") {
    const scan = report?.runs?.[0];
    const invocation = scan?.invocations?.[0];
    if (
      report?.version !== "2.1.0" ||
      scan?.tool?.driver?.name !== "Zedbee" ||
      !Array.isArray(scan?.results) ||
      !Array.isArray(invocation?.toolExecutionNotifications)
    )
      throw new Error("Invalid SARIF");
    outcome = invocation.properties?.outcome;
    reportExitCode = invocation.properties?.exitCode;
    findings = scan.results.length;
    incomplete = invocation.toolExecutionNotifications.length;
  } else {
    if (report?.schemaVersion !== 1 || !Array.isArray(report?.checks))
      throw new Error("Invalid JSON report");
    outcome = report.outcome;
    reportExitCode = report.exitCode;
    findings = report.checks.reduce((count, check) => {
      if (!Array.isArray(check.findings))
        throw new Error("Invalid check findings");
      return count + check.findings.length;
    }, 0);
    incomplete = report.checks.filter(
      (check) => check.status === "incomplete",
    ).length;
  }
  const expected = { pass: 0, blocked: 1, incomplete: 2 };
  if (
    !Object.hasOwn(expected, outcome) ||
    expected[outcome] !== code ||
    reportExitCode !== code
  )
    throw new Error("Invalid report outcome");
  return { outcome, exitCode: code, findings, incomplete };
}

function artifactLink(env) {
  try {
    const server = new URL(env.GITHUB_SERVER_URL);
    if (
      server.protocol !== "https:" ||
      server.username ||
      server.password ||
      server.pathname !== "/" ||
      server.search ||
      server.hash
    )
      return "";
    if (
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY ?? "") ||
      !/^\d+$/.test(env.GITHUB_RUN_ID ?? "")
    )
      return "";
    return `\n[Download report artifacts](${server.origin}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}#artifacts).\n`;
  } catch {
    return "";
  }
}

async function publish(result, env, detail) {
  // Only fixed labels, validated URLs, and numeric counts reach Markdown or outputs.
  const label = { pass: "Pass", blocked: "Blocked", incomplete: "Incomplete" }[
    result.outcome
  ];
  const counts =
    result.findings === null
      ? "Findings and incomplete check counts unavailable."
      : `${result.findings} findings; ${result.incomplete} incomplete checks.`;
  const summary = `## Zedbee: ${label}\n\n${counts}\n\n${detail}\n${result.reportPath ? artifactLink(env) : ""}`;
  if (env.GITHUB_STEP_SUMMARY)
    await appendFile(env.GITHUB_STEP_SUMMARY, summary);
  if (env.GITHUB_OUTPUT)
    await appendFile(
      env.GITHUB_OUTPUT,
      `report-path=${result.reportPath}\nexit-code=${result.exitCode}\noutcome=${result.outcome}\n`,
    );
}

/** Execute the real installed CLI. The installer is the external network boundary. */
export async function runAction({
  env = process.env,
  install = installPackage,
} = {}) {
  let result = {
    reportPath: "",
    exitCode: 2,
    outcome: "incomplete",
    findings: null,
    incomplete: null,
  };
  let detail =
    "Invalid Action inputs or PR event. No complete scan report was produced.";
  try {
    const options = await inputs(env);
    const root = await mkdtemp(join(env.RUNNER_TEMP, "zedbee-scan-"));
    await chmod(root, 0o700);
    // GITHUB_OUTPUT uses one-line records; reject unusual runner directory names.
    if (/[\r\n]/.test(root)) throw new Error("Invalid runner directory");
    detail = "Installation failed. No complete scan report was produced.";
    const cli = await install({ version: options.version, root, env });
    detail =
      "Scanner startup or execution failed. No complete scan report was produced.";
    const rawPath = join(root, "scanner-output.txt");
    const output = await open(rawPath, "wx", 0o600);
    result.reportPath = rawPath;
    let child;
    try {
      child = await run(
        process.execPath,
        [
          cli,
          "scan",
          "--base",
          options.base,
          "--format",
          options.format,
          "--no-source",
          "--no-color",
          "--no-service",
          ...(options.trust ? ["--trust-project-prettier"] : []),
        ],
        {
          cwd: env.GITHUB_WORKSPACE,
          env: childEnvironment(env),
          stdio: ["ignore", output.fd, "ignore"],
        },
      );
    } finally {
      await output.close();
    }
    const parsed = JSON.parse(await readFile(rawPath, "utf8"));
    const summary = reportSummary(parsed, options.format, child.code);
    const reportPath = join(root, `report.${options.format}`);
    await rename(rawPath, reportPath);
    result = { reportPath, ...summary };
    detail =
      "Complete scan report written for artifact upload. Source excerpts are disabled.";
  } catch {
    // Keep raw stdout for diagnosis without presenting it as a valid JSON/SARIF report.
  }
  await publish(result, env, detail);
  return result;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    process.exitCode = (await runAction()).exitCode;
  } catch {
    console.error("Zedbee Action could not write its result. Scan incomplete.");
    process.exitCode = 2;
  }
}
