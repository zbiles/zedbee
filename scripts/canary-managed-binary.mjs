import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
};
const engine = argument("--engine");
const packageDirectory = argument("--package");
if (
  (engine !== "gitleaks" && engine !== "osv-scanner") ||
  packageDirectory === undefined
) {
  throw new Error("Use --engine gitleaks|osv-scanner --package <directory>.");
}

const packageRoot = resolve(packageDirectory);
const manifest = JSON.parse(
  await readFile(resolve(packageRoot, "manifest.json"), "utf8"),
);
if (manifest.engine !== engine)
  throw new Error("Canary package engine mismatch.");
const executable = resolve(packageRoot, manifest.executablePath);
const scratch = await mkdtemp(join(tmpdir(), "zedbee-managed-canary-"));

try {
  if (engine === "gitleaks") {
    const token = `ghp_${randomBytes(27).toString("base64url").slice(0, 36)}`;
    await writeFile(
      join(scratch, "canary.js"),
      `export const githubToken = ${JSON.stringify(token)};\n`,
    );
    const reportPath = join(scratch, "gitleaks.json");
    const result = await execa(
      executable,
      [
        "dir",
        "--no-banner",
        "--redact",
        "--config",
        resolve(packageRoot, manifest.configPath),
        "--report-format",
        "json",
        "--report-path",
        reportPath,
        scratch,
      ],
      { shell: false, stdin: "ignore", reject: false },
    );
    if (result.exitCode !== 1)
      throw new Error("Gitleaks canary was not detected.");
    const raw = await readFile(reportPath, "utf8");
    const report = JSON.parse(raw);
    if (!Array.isArray(report) || report.length === 0 || raw.includes(token)) {
      throw new Error("Gitleaks canary redaction failed.");
    }
  } else {
    await writeFile(
      join(scratch, "package-lock.json"),
      `${JSON.stringify(
        {
          name: "zedbee-osv-canary",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "zedbee-osv-canary",
              version: "1.0.0",
              dependencies: { lodash: "4.17.20" },
            },
            "node_modules/lodash": { version: "4.17.20" },
          },
        },
        null,
        2,
      )}\n`,
    );
    const result = await execa(
      executable,
      ["scan", "source", "--format=json", "--recursive", scratch],
      { cwd: scratch, shell: false, stdin: "ignore", reject: false },
    );
    if (result.exitCode !== 1) throw new Error("OSV canary was not detected.");
    const report = JSON.parse(result.stdout);
    const vulnerabilities = (report.results ?? []).flatMap((item) =>
      (item.packages ?? []).flatMap((entry) => entry.vulnerabilities ?? []),
    );
    if (vulnerabilities.length === 0) {
      throw new Error("OSV canary report contained no advisory.");
    }
  }
  console.log(`${engine} canary passed.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
