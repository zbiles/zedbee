import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const execute = promisify(execFile);
const entry = fileURLToPath(new URL("../../dist/cli.js", import.meta.url));
const probe = [
  "import { registerHooks } from 'node:module';",
  "import { pathToFileURL } from 'node:url';",
  "const loaded = new Set();",
  "registerHooks({ load(url, context, next) { loaded.add(url); return next(url, context); } });",
  "const [entry, arg] = process.argv.slice(1);",
  "process.argv = [process.execPath, entry, arg];",
  "await import(pathToFileURL(entry));",
  "process.stderr.write(JSON.stringify([...loaded].filter(url => /\\/node_modules\\/(?:prettier|@secretlint\\/core|@yarnpkg\\/lockfile)\\//u.test(url))));",
].join("\n");

it.each(["--version", "--help"])(
  "loads no analyzer packages for cold %s",
  async (flag) => {
    const { stdout, stderr } = await execute(process.execPath, [
      "--input-type=module",
      "-e",
      probe,
      entry,
      flag,
    ]);
    expect(stdout).toMatch(
      flag === "--version" ? /^\d+\.\d+\.\d+/u : /Usage: zedbee/u,
    );
    expect(JSON.parse(stderr)).toEqual([]);
  },
);
