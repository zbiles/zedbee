import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeDoctorCommand,
  type DoctorCommandOptions,
  type DoctorCommandIO,
} from "../../src/commands/doctor.js";
import {
  createDefaultDiagnosticProbe,
  DOCTOR_DIAGNOSTIC_IDS,
  defaultDiagnosticProbe,
  runDiagnostics,
  type DiagnosticProbe,
} from "../../src/doctor/diagnostics.js";
import { OsvUnavailableError } from "../../src/checks/vulnerabilities/osv/errors.js";
import { createGitRepository } from "../helpers/git-repository.js";

const passProbe: DiagnosticProbe = async (id) => ({
  id,
  status: "pass",
  message: `${id} is ready.`,
});

function terminal(
  options: {
    readonly stdoutIsTTY?: boolean;
    readonly width?: number;
    readonly env?: Record<string, string | undefined>;
  } = {},
): DoctorCommandIO & {
  stdout: string[];
  stderr: string[];
  stdoutIsTTY: boolean;
  width: number;
  env: Record<string, string | undefined>;
} {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    stdoutIsTTY: options.stdoutIsTTY ?? false,
    width: options.width ?? 80,
    env: options.env ?? {},
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
  };
}

function doctorOptions(
  overrides: Partial<DoctorCommandOptions> = {},
): DoctorCommandOptions {
  return {
    cwd: "/repo",
    format: "auto",
    environment: {},
    color: true,
    ...overrides,
  } as DoctorCommandOptions;
}

describe("doctor diagnostics", () => {
  it("uses Node-native security and connectivity diagnostics only", () => {
    expect(DOCTOR_DIAGNOSTIC_IDS).toEqual(
      expect.arrayContaining([
        "secretlint-readiness",
        "lockfile-support",
        "osv-connectivity",
      ]),
    );
    expect(DOCTOR_DIAGNOSTIC_IDS).not.toEqual(
      expect.arrayContaining([
        "managed-engines",
        "managed-engine-checksums",
        "offline-database",
      ]),
    );
  });

  it("runs every setup diagnostic without invoking a scan", async () => {
    const visited: string[] = [];
    const diagnostics = await runDiagnostics(
      async (id, context) => {
        visited.push(id);
        expect(context.cwd).toBe("/repo");
        return passProbe(id, context);
      },
      { cwd: "/repo", environment: {} },
    );

    expect(visited).toEqual(DOCTOR_DIAGNOSTIC_IDS);
    expect(diagnostics.map(({ id }) => id)).toEqual(DOCTOR_DIAGNOSTIC_IDS);
  });

  it("converts probe crashes into sanitized failures", async () => {
    const diagnostics = await runDiagnostics(
      async (id) => {
        if (id === "secretlint-readiness")
          throw new Error("token=/private/tmp/secret");
        return passProbe(id, { cwd: "/repo", environment: {} });
      },
      { cwd: "/repo", environment: {} },
    );

    expect(diagnostics.find(({ id }) => id === "secretlint-readiness")).toEqual(
      {
        id: "secretlint-readiness",
        status: "fail",
        message: "The diagnostic could not be completed.",
        remediation:
          "Run zedbee doctor again after correcting the reported setup issue.",
      },
    );
    expect(JSON.stringify(diagnostics)).not.toContain(
      "token=/private/tmp/secret",
    );
  });

  it("validates Secretlint directly without a managed executable", async () => {
    await expect(
      defaultDiagnosticProbe("secretlint-readiness", {
        cwd: "/repo",
        environment: {},
      }),
    ).resolves.toMatchObject({
      id: "secretlint-readiness",
      status: "pass",
      message: expect.stringContaining("Secretlint"),
    });
  });

  it("parses the staged JavaScript lockfile inventory", async () => {
    const repository = await createGitRepository("zedbee-doctor-lockfile-");
    await repository.write(
      "package.json",
      `${JSON.stringify({ name: "fixture", dependencies: { lodash: "4.17.21" } })}\n`,
    );
    await repository.write(
      "package-lock.json",
      `${JSON.stringify({
        name: "fixture",
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { lodash: "4.17.21" } },
          "node_modules/lodash": { version: "4.17.21" },
        },
      })}\n`,
    );
    await repository.commitAll("fixture");

    await expect(
      defaultDiagnosticProbe("lockfile-support", {
        cwd: repository.root,
        environment: {},
      }),
    ).resolves.toMatchObject({
      status: "pass",
      message: expect.stringContaining("package-lock.json"),
    });
  });

  it("ignores lockfile fixtures outside project roots", async () => {
    const repository = await createGitRepository(
      "zedbee-doctor-fixture-lockfile-",
    );
    await repository.write(
      "package.json",
      `${JSON.stringify({ name: "fixture", dependencies: { lodash: "4.17.21" } })}\n`,
    );
    await repository.write(
      "package-lock.json",
      `${JSON.stringify({
        name: "fixture",
        lockfileVersion: 3,
        packages: {
          "": { dependencies: { lodash: "4.17.21" } },
          "node_modules/lodash": { version: "4.17.21" },
        },
      })}\n`,
    );
    await repository.write(
      "test/fixtures/lockfiles/bun/bun.lockb",
      "intentional binary-lockfile fixture\n",
    );
    await repository.commitAll("fixture");

    await expect(
      defaultDiagnosticProbe("lockfile-support", {
        cwd: repository.root,
        environment: {},
      }),
    ).resolves.toMatchObject({
      status: "pass",
      message: expect.stringContaining("package-lock.json"),
    });
  });

  it.each([
    ["block", "fail"],
    ["warn", "warning"],
  ] as const)(
    "applies the configured OSV %s outage policy to connectivity",
    async (onUnavailable, expectedStatus) => {
      const repository = await createGitRepository("zedbee-doctor-osv-");
      await repository.write(
        "package.json",
        `${JSON.stringify({ name: "fixture" })}\n`,
      );
      await repository.write(
        ".zedbeerc.jsonc",
        `${JSON.stringify({
          schemaVersion: 1,
          checks: {
            vulnerabilities: { severity: "error", onUnavailable },
          },
        })}\n`,
      );
      await repository.commitAll("fixture");
      const probe = createDefaultDiagnosticProbe({
        osvClient: {
          query: async () => new Map(),
          probe: async () => {
            throw new OsvUnavailableError(
              "OSV_NETWORK_UNAVAILABLE",
              "Zedbee could not connect to OSV.",
            );
          },
        },
      });

      await expect(
        probe("osv-connectivity", {
          cwd: repository.root,
          environment: {},
        }),
      ).resolves.toMatchObject({
        status: expectedStatus,
        message: "Zedbee could not connect to OSV.",
        remediation: expect.stringContaining("onUnavailable"),
      });
    },
  );

  it("uses a constant synthetic OSV probe and sends no repository inventory", async () => {
    const repository = await createGitRepository("zedbee-doctor-osv-");
    await repository.write(
      "package.json",
      `${JSON.stringify({ name: "fixture" })}\n`,
    );
    await repository.write(
      ".zedbeerc.jsonc",
      `${JSON.stringify({
        schemaVersion: 1,
        checks: { vulnerabilities: "error" },
      })}\n`,
    );
    await repository.commitAll("fixture");
    let probes = 0;
    const probe = createDefaultDiagnosticProbe({
      osvClient: {
        query: async () => {
          throw new Error("doctor must not submit a repository inventory");
        },
        probe: async () => {
          probes += 1;
        },
      },
    });

    await expect(
      probe("osv-connectivity", {
        cwd: repository.root,
        environment: {},
      }),
    ).resolves.toMatchObject({ status: "pass" });
    expect(probes).toBe(1);
  });

  it("describes the exact OSV disclosure and configured outage behavior", async () => {
    const repository = await createGitRepository("zedbee-doctor-disclosure-");
    await repository.write(
      "package.json",
      `${JSON.stringify({ name: "fixture" })}\n`,
    );
    await repository.write(
      ".zedbeerc.jsonc",
      `${JSON.stringify({
        schemaVersion: 1,
        checks: {
          vulnerabilities: { severity: "error", onUnavailable: "warn" },
        },
      })}\n`,
    );
    await repository.commitAll("fixture");

    const diagnostic = await defaultDiagnosticProbe(
      "online-service-disclosure",
      { cwd: repository.root, environment: {} },
    );

    expect(diagnostic).toMatchObject({ status: "warning" });
    expect(diagnostic.message).toContain(
      "package names, exact versions, and ecosystem identifiers",
    );
    expect(diagnostic.message).toContain("warn and allow commits");
    expect(diagnostic.message).toContain("file hashes are not sent");
    expect(diagnostic.message).not.toContain("deps.dev");
  });

  it("warns when an unrelated pre-commit hook exists", async () => {
    const repository = await createGitRepository("zedbee-doctor-hook-");
    const hookPath = join(repository.root, ".git/hooks/pre-commit");
    await writeFile(hookPath, "#!/bin/sh\nnpm test\n");
    await chmod(hookPath, 0o755);

    const diagnostic = await defaultDiagnosticProbe("hook-state", {
      cwd: repository.root,
      environment: {},
    });

    expect(diagnostic).toMatchObject({
      status: "warning",
      message: expect.stringContaining("does not invoke Zedbee"),
    });
  });

  it("passes only when a raw pre-commit hook actually invokes Zedbee", async () => {
    const repository = await createGitRepository("zedbee-doctor-hook-");
    const hookPath = join(repository.root, ".git/hooks/pre-commit");
    await writeFile(hookPath, "#!/bin/sh\nnpx --no-install zedbee scan\n");
    await chmod(hookPath, 0o755);

    const diagnostic = await defaultDiagnosticProbe("hook-state", {
      cwd: repository.root,
      environment: {},
    });

    expect(diagnostic).toMatchObject({ status: "pass" });
  });

  it("warns when simple-git-hooks is configured but not activated", async () => {
    const repository = await createGitRepository("zedbee-doctor-simple-");
    await writeFile(
      join(repository.root, "package.json"),
      `${JSON.stringify({
        "simple-git-hooks": {
          "pre-commit": "npx --no-install zedbee scan",
        },
      })}\n`,
    );

    const diagnostic = await defaultDiagnosticProbe("hook-state", {
      cwd: repository.root,
      environment: {},
    });

    expect(diagnostic).toMatchObject({
      status: "warning",
      message: expect.stringContaining("simple-git-hooks"),
      remediation: expect.stringContaining("simple-git-hooks"),
    });
  });

  it("warns precisely when Lefthook is configured but not activated", async () => {
    const repository = await createGitRepository("zedbee-doctor-lefthook-");
    await writeFile(
      join(repository.root, "lefthook.yml"),
      "pre-commit:\n  commands:\n    zedbee:\n      run: npx --no-install zedbee scan\n",
    );

    const diagnostic = await defaultDiagnosticProbe("hook-state", {
      cwd: repository.root,
      environment: {},
    });

    expect(diagnostic).toMatchObject({
      status: "warning",
      message: expect.stringContaining("configured but is not active"),
      remediation: expect.stringContaining("lefthook install"),
    });
  });

  it("passes an active Lefthook runner only when its config invokes Zedbee", async () => {
    const repository = await createGitRepository("zedbee-doctor-lefthook-");
    await writeFile(
      join(repository.root, "lefthook.yml"),
      "pre-commit:\n  commands:\n    zedbee:\n      run: npx --no-install zedbee scan\n",
    );
    const hookPath = join(repository.root, ".git/hooks/pre-commit");
    await writeFile(
      hookPath,
      [
        "#!/bin/sh",
        "call_lefthook()",
        "{",
        '  if test -n "$LEFTHOOK_BIN"; then',
        '    "$LEFTHOOK_BIN" "$@"',
        "  elif lefthook -h >/dev/null 2>&1; then",
        '    lefthook "$@"',
        "  fi",
        "}",
        'call_lefthook run "pre-commit" "$@"',
        "",
      ].join("\n"),
    );
    await chmod(hookPath, 0o755);

    const diagnostic = await defaultDiagnosticProbe("hook-state", {
      cwd: repository.root,
      environment: {},
    });

    expect(diagnostic).toMatchObject({ status: "pass" });
    expect(await readFile(hookPath, "utf8")).not.toContain("zedbee scan");
  });
});

describe("executeDoctorCommand", () => {
  it("renders one large colored Doctor panel in a wide interactive terminal", async () => {
    const io = terminal({ stdoutIsTTY: true, width: 100 });

    await executeDoctorCommand(doctorOptions(), io, {
      diagnose: async () => [
        { id: "git", status: "pass", message: "Git is ready." },
        {
          id: "hook-state",
          status: "warning",
          message: "No hook is installed.",
          remediation: "Run zedbee init.",
        },
        { id: "node", status: "fail", message: "Node is too old." },
      ],
    });

    const output = io.stdout.join("");
    expect(output).toContain("DOCTOR");
    expect(output.match(/DOCTOR/gu)).toHaveLength(1);
    expect(output).toContain("Git is ready.");
    expect(output).toContain("Run zedbee init.");
    expect(output).toContain("PASS");
    expect(output).toContain("WARNING");
    expect(output).toContain("FAIL");
  });

  it.each([
    ["narrow terminal", terminal({ stdoutIsTTY: true, width: 79 }), {}],
    ["redirected output", terminal({ stdoutIsTTY: false, width: 120 }), {}],
    [
      "dumb terminal",
      terminal({ stdoutIsTTY: true, width: 120, env: { TERM: "dumb" } }),
      { environment: { TERM: "dumb" } },
    ],
    [
      "CI pseudo-terminal",
      terminal({ stdoutIsTTY: true, width: 120, env: { CI: "true" } }),
      { environment: { CI: "true" } },
    ],
  ] as const)("uses plain text for %s", async (_name, io, overrides) => {
    await executeDoctorCommand(doctorOptions(overrides), io, {
      diagnose: async () => [
        { id: "git", status: "pass", message: "Git is ready." },
      ],
    });

    expect(io.stdout.join("")).toBe("PASS git: Git is ready.\n");
    expect(io.stdout.join("")).not.toMatch(/\u001B\[[0-9;]*m/u);
  });

  it("lets explicit text force the plain view in a wide terminal", async () => {
    const io = terminal({ stdoutIsTTY: true, width: 120 });

    await executeDoctorCommand(doctorOptions({ format: "text" }), io, {
      diagnose: async () => [
        { id: "git", status: "pass", message: "Git is ready." },
      ],
    });

    expect(io.stdout.join("")).toBe("PASS git: Git is ready.\n");
  });

  it("returns zero for pass/warning diagnostics and deterministic JSON", async () => {
    const io = terminal();
    const result = await executeDoctorCommand(
      doctorOptions({ format: "json" }),
      io,
      {
        diagnose: async () => [
          { id: "git", status: "pass", message: "Git is ready." },
          {
            id: "hook-state",
            status: "warning",
            message: "No hook is installed.",
          },
        ],
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(io.stdout.join(""))).toEqual(result);
    expect(io.stderr).toEqual([]);
  });

  it("returns two on any failure and keeps piped text ANSI-free", async () => {
    const io = terminal();
    const result = await executeDoctorCommand(
      doctorOptions({ format: "text" }),
      io,
      {
        diagnose: async () => [
          {
            id: "node",
            status: "fail",
            message: "Node is too old.",
            remediation: "Install Node 22.13 or newer.",
          },
        ],
      },
    );
    expect(result.exitCode).toBe(2);
    expect(io.stdout.join("")).toContain("FAIL node: Node is too old.");
    expect(io.stdout.join("")).not.toMatch(/\u001B\[[0-9;]*m/u);
  });
});
