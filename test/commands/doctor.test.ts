import { chmod, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  executeDoctorCommand,
  type DoctorCommandIO,
} from "../../src/commands/doctor.js";
import {
  DOCTOR_DIAGNOSTIC_IDS,
  defaultDiagnosticProbe,
  runDiagnostics,
  type DiagnosticProbe,
} from "../../src/doctor/diagnostics.js";
import { createGitRepository } from "../helpers/git-repository.js";

const passProbe: DiagnosticProbe = async (id) => ({
  id,
  status: "pass",
  message: `${id} is ready.`,
});

function terminal(): DoctorCommandIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
  };
}

describe("doctor diagnostics", () => {
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
        if (id === "managed-engine-checksums")
          throw new Error("token=/private/tmp/secret");
        return passProbe(id, { cwd: "/repo", environment: {} });
      },
      { cwd: "/repo", environment: {} },
    );

    expect(
      diagnostics.find(({ id }) => id === "managed-engine-checksums"),
    ).toEqual({
      id: "managed-engine-checksums",
      status: "fail",
      message: "The diagnostic could not be completed.",
      remediation:
        "Run zedbee doctor again after correcting the reported setup issue.",
    });
    expect(JSON.stringify(diagnostics)).not.toContain("secret");
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
  it("returns zero for pass/warning diagnostics and deterministic JSON", async () => {
    const io = terminal();
    const result = await executeDoctorCommand(
      { cwd: "/repo", format: "json", environment: {} },
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
      { cwd: "/repo", format: "text", environment: {} },
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
