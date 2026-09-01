import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";

function validatedNpmCli(candidate) {
  if (typeof candidate !== "string" || candidate.length === 0) return undefined;
  try {
    const canonical = realpathSync(candidate);
    const cliDirectory = dirname(canonical);
    const packageRoot = dirname(cliDirectory);
    const packageMetadata = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    );
    if (
      basename(canonical).toLowerCase() !== "npm-cli.js" ||
      basename(cliDirectory).toLowerCase() !== "bin" ||
      packageMetadata?.name !== "npm" ||
      !lstatSync(canonical).isFile()
    ) {
      return undefined;
    }
    return canonical;
  } catch {
    return undefined;
  }
}

export function resolveNpmCliPath(options = {}) {
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const npmExecPath = options.npmExecPath ?? process.env.npm_execpath;
  const pathValue = options.pathValue ?? process.env.PATH ?? "";
  const nodeDirectory = dirname(nodeExecutable);
  const candidates = [
    npmExecPath,
    join(nodeDirectory, "node_modules", "npm", "bin", "npm-cli.js"),
    resolve(nodeDirectory, "../lib/node_modules/npm/bin/npm-cli.js"),
  ];
  for (const entry of pathValue.split(delimiter).filter(Boolean)) {
    candidates.push(
      join(entry, "npm"),
      join(entry, "node_modules", "npm", "bin", "npm-cli.js"),
      resolve(entry, "../lib/node_modules/npm/bin/npm-cli.js"),
    );
  }
  for (const candidate of candidates) {
    const validated = validatedNpmCli(candidate);
    if (validated !== undefined) return validated;
  }
  throw new Error("Verification could not locate npm's JavaScript entry point.");
}

export function commandInvocation(command, args, options = {}) {
  if (command !== "npm") {
    return Object.freeze({ executable: command, args: Object.freeze([...args]) });
  }
  const nodeExecutable = options.nodeExecutable ?? process.execPath;
  const npmCliPath =
    options.npmCliPath ?? resolveNpmCliPath({ ...options, nodeExecutable });
  return Object.freeze({
    executable: nodeExecutable,
    args: Object.freeze([npmCliPath, ...args]),
  });
}
