import {
  chmodSync,
  lstatSync,
  realpathSync,
  readFileSync,
  copyFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
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

const resolver = join(root, "assets", "oxc-resolver", "resolver.wasm");
if (
  lstatSync(resolver).isSymbolicLink() ||
  createHash("sha256").update(readFileSync(resolver)).digest("hex") !==
    "07f08138508b5b5832874cd5218ee1b7ac4ee987e01fbdc1a825512d380658b9"
)
  throw new Error("Invalid pinned Knip resolver build asset");
for (const [source, target] of [
  ["resolver.wasm", "resolver.wasm"],
  ["LICENSE", "resolver.LICENSE"],
  ["provenance.json", "resolver.provenance.json"],
])
  copyFileSync(
    join(root, "assets", "oxc-resolver", source),
    join(root, "dist", "checks", "dead-code", target),
  );
