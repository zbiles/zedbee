import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { promisify } from "node:util";
import { commandInvocation } from "./command-invocation.mjs";

// npm resolves the unpublished candidate by its normal exact-version specifier.
// The fixture registry serves only Swarm. All other package requests go to npm.
const [root, archivePath] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const archive = readFileSync(archivePath);
const integrity =
  "sha512-" + createHash("sha512").update(archive).digest("base64");
const archiveUrl = `/zedbee/-/zedbee-${manifest.version}.tgz`;
let registry;
const server = createServer((request, response) => {
  const path = new URL(request.url, "http://127.0.0.1").pathname;
  if (request.method !== "GET") {
    response.writeHead(405).end();
  } else if (path === "/zedbee") {
    response.writeHead(200, { "content-type": "application/json" }).end(
      JSON.stringify({
        name: "zedbee",
        "dist-tags": { latest: manifest.version },
        versions: {
          [manifest.version]: {
            ...manifest,
            dist: { tarball: registry + archiveUrl, integrity },
          },
        },
      }),
    );
  } else if (path === archiveUrl) {
    response
      .writeHead(200, { "content-type": "application/octet-stream" })
      .end(archive);
  } else {
    const publicUrl = new URL("https://registry.npmjs.org");
    publicUrl.pathname = path;
    response.writeHead(302, { location: publicUrl.href }).end();
  }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
registry = `http://127.0.0.1:${server.address().port}`;
try {
  const invocation = commandInvocation("npm", [
    "install",
    "--save-dev",
    "--save-exact",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--userconfig",
    process.platform === "win32" ? "NUL" : "/dev/null",
    "--registry",
    registry,
    `zedbee@${manifest.version}`,
  ]);
  await promisify(execFile)(invocation.executable, invocation.args);
  process.stdout.write(integrity);
} catch (error) {
  process.stderr.write(error.stderr || error.message);
  process.exitCode = 1;
} finally {
  server.close();
}
