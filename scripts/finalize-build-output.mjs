import { chmodSync, lstatSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const root = realpathSync(process.cwd());
const cli = join(root, "dist", "cli.js");
const metadata = lstatSync(cli);

if (
  metadata.isSymbolicLink() ||
  !metadata.isFile() ||
  realpathSync(cli) !== cli ||
  dirname(dirname(cli)) !== root ||
  basename(dirname(cli)) !== "dist" ||
  basename(cli) !== "cli.js"
) {
  throw new Error("Refused to finalize an invalid CLI build output.");
}

if (process.platform !== "win32") chmodSync(cli, 0o755);
