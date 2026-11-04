// Source of truth for CLI and independently packaged plugin installation.
// The plugin copy is generated and byte-checked by scripts/prepare-plugin.mjs.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
function validate(manager, packageSpec) {
  if (
    !MANAGERS.has(manager) ||
    !/^zedbee@\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/u.test(packageSpec)
  )
    throw new Error(
      "Installation requires a supported manager and an exact zedbee version.",
    );
}
export function installArguments(
  manager,
  workspaceRoot,
  classicYarn,
  packageSpec,
) {
  validate(manager, packageSpec);
  if (manager === "npm")
    return [
      "install",
      "--save-dev",
      "--save-exact",
      "--ignore-scripts",
      packageSpec,
    ];
  if (manager === "pnpm")
    return [
      "add",
      ...(workspaceRoot ? ["--workspace-root"] : []),
      "--save-dev",
      "--save-exact",
      "--ignore-scripts",
      "--ignore-pnpmfile",
      "--manage-package-manager-versions=false",
      packageSpec,
    ];
  return [
    "add",
    "--dev",
    "--exact",
    ...(manager === "yarn"
      ? classicYarn
        ? [
            "--ignore-scripts",
            "--no-default-rc",
            ...(workspaceRoot ? ["--ignore-workspace-root-check"] : []),
          ]
        : ["--mode=skip-build"]
      : ["--ignore-scripts"]),
    packageSpec,
  ];
}

// Windows cannot execute .cmd shims without a shell. Resolve the static Node
// entry used by npm-installed and Corepack shims instead of evaluating cmd text.
export async function windowsManagerInvocation(manager, pathValue) {
  for (const directory of pathValue.split(";")) {
    if (!directory) continue;
    const root = directory.replace(/^"|"$/gu, "");
    for (const extension of [".exe", ".cmd"]) {
      const executable = join(root, `${manager}${extension}`);
      if (!(await lstat(executable).catch(() => undefined))?.isFile()) continue;
      if (extension === ".exe") return { command: executable, args: [] };
      const shim = await readFile(executable, "utf8");
      const entry = /"(?:%~dp0|%dp0%)[\\/]([^"\r\n]+\.(?:c?js))"/iu.exec(
        shim,
      )?.[1];
      if (entry !== undefined && !entry.includes("%")) {
        const script = resolve(root, entry.replaceAll("\\", "/"));
        if ((await lstat(script).catch(() => undefined))?.isFile())
          return { command: process.execPath, args: [script] };
      }
      throw new Error(
        `Cannot safely resolve the installed ${manager} Windows shim to its Node entry. Use a standard package-manager installation.`,
      );
    }
  }
  throw new Error(`Could not find the installed ${manager} package manager.`);
}

function terminateTree(child) {
  if (child.pid === undefined) return;
  if (process.platform === "win32") {
    const killer = spawn(
      join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe"),
      ["/pid", String(child.pid), "/T", "/F"],
      { stdio: "ignore", windowsHide: true },
    );
    killer.once("error", () => child.kill());
  } else {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

// No dependencies: this same executable ships inside the independent plugin ZIP.
async function execute(command, args, options) {
  options.cancelSignal?.throwIfAborted();
  const invocation =
    process.platform === "win32"
      ? await windowsManagerInvocation(
          command,
          process.env.PATH ?? process.env.Path ?? "",
        )
      : { command, args: [] };
  return new Promise((resolve, reject) => {
    const child = spawn(invocation.command, [...invocation.args, ...args], {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    let failure;
    const stop = (error) => {
      failure ??= error;
      terminateTree(child);
    };
    const abort = () =>
      stop(options.cancelSignal.reason ?? new Error("Installation cancelled."));
    const deadline = setTimeout(
      () => stop(new Error("Package manager installation timed out.")),
      options.timeout,
    );
    options.cancelSignal?.addEventListener("abort", abort, { once: true });
    if (options.cancelSignal?.aborted) abort();
    const cleanup = () => {
      clearTimeout(deadline);
      options.cancelSignal?.removeEventListener("abort", abort);
    };
    for (const [stream, chunks] of [
      [child.stdout, stdout],
      [child.stderr, stderr],
    ]) {
      stream.on("data", (chunk) => {
        bytes += chunk.length;
        if (bytes > 16 * 1024 * 1024)
          stop(
            new Error(
              "Package manager output exceeded the installation limit.",
            ),
          );
        else chunks.push(chunk);
      });
    }
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("close", (code) => {
      cleanup();
      if (failure !== undefined) reject(failure);
      else
        resolve({
          exitCode: code ?? 1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
  });
}

export async function installDependency(
  { manager, cwd, packageSpec, workspaceRoot = false, signal },
  run = execute,
) {
  validate(manager, packageSpec);
  const env = {
    COREPACK_ENABLE_PROJECT_SPEC: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    npm_config_ignore_scripts: "true",
    NPM_CONFIG_IGNORE_SCRIPTS: "true",
    YARN_IGNORE_PATH: "1",
    YARN_RC_FILENAME: `.zedbee-${randomUUID()}.yarnrc.yml`,
    YARN_ENABLE_SCRIPTS: "false",
    YARN_NODE_LINKER: "node-modules",
  };
  let classicYarn = false;
  if (manager === "yarn") {
    // Repository declarations cannot identify the installed executable. Probe
    // away from project rc/delegation before selecting Classic/modern flags.
    const probeRoot = await mkdtemp(join(tmpdir(), "zedbee-yarn-version-"));
    try {
      const version = await run("yarn", ["--version"], {
        cwd: probeRoot,
        env,
        cancelSignal: signal,
        timeout: 30_000,
        stdin: "ignore",
        reject: false,
      });
      const major = /^(\d+)\.\d+\.\d+(?:[-+][\w.-]+)?$/u.exec(
        version.stdout.trim(),
      )?.[1];
      if (version.exitCode !== 0 || major === undefined || Number(major) < 1)
        throw new Error(
          "Could not identify a supported Yarn version for a script-free installation.",
        );
      if (major === "2")
        throw new Error(
          "Yarn 2 cannot safely add this dependency without workspace builds. Use Yarn 1 or Yarn 3 and newer for automatic installation.",
        );
      classicYarn = major === "1";
    } finally {
      await rm(probeRoot, { recursive: true, force: true });
    }
  }
  const result = await run(
    manager,
    installArguments(manager, workspaceRoot, classicYarn, packageSpec),
    {
      cwd: await realpath(cwd),
      env,
      cancelSignal: signal,
      killDescendants: true,
      timeout: 300_000,
      maxBuffer: 16 * 1024 * 1024,
      stdin: "ignore",
      reject: false,
    },
  );
  if (result.exitCode !== 0)
    throw new Error(
      (result.stderr || result.stdout).trim().slice(-800) ||
        "Zedbee installation failed. Check your package manager and registry access.",
    );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  // Keep the helper alive until cancellation has closed its manager tree.
  // Detached POSIX children do not receive the helper's terminal signals.
  const cancellation = new AbortController();
  let interruptedSignal;
  const interrupt = (signal) => () => {
    if (cancellation.signal.aborted) return;
    interruptedSignal = signal;
    cancellation.abort(new Error(`Installation cancelled by ${signal}.`));
  };
  const onInterrupt = interrupt("SIGINT");
  const onTerminate = interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  try {
    const options = {};
    const args = process.argv.slice(2);
    for (let index = 0; index < args.length; index++) {
      const name = args[index];
      if (name === "--workspace-root" && options.workspaceRoot === undefined)
        options.workspaceRoot = true;
      else if (["--manager", "--project-root", "--package"].includes(name)) {
        const key = {
          "--manager": "manager",
          "--project-root": "cwd",
          "--package": "packageSpec",
        }[name];
        if (
          options[key] !== undefined ||
          !args[index + 1] ||
          args[index + 1].startsWith("--")
        )
          throw new Error("Invalid installation arguments.");
        options[key] = args[++index];
      } else throw new Error("Invalid installation arguments.");
    }
    if (!options.cwd)
      throw new Error("An explicit selected project root is required.");
    await installDependency({ ...options, signal: cancellation.signal });
  } catch (error) {
    console.error(error.message);
    process.exitCode =
      interruptedSignal === "SIGINT"
        ? 130
        : interruptedSignal === "SIGTERM"
          ? 143
          : 2;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onTerminate);
  }
}
