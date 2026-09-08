import { afterEach, expect, it } from "vitest";
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedContentIdentity } from "../../src/service/identity.js";
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});
async function fixture() {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "zedbee-service-identity-")),
  );
  roots.push(root);
  await mkdir(join(root, "dist"));
  await writeFile(join(root, "dist", "entry.js"), "export {};");
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "zedbee",
      version: "1.0.0",
      dependencies: { engine: "1.0.0" },
    }),
  );
  const dependency = join(root, "node_modules", "engine");
  await mkdir(dependency, { recursive: true });
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({ name: "engine", version: "1.0.0", main: "engine.js" }),
  );
  await writeFile(join(dependency, "engine.js"), "export const engine = 1;");
  return { root, dependency };
}
it("detects same-version code, native asset, transitive dependency and installed path changes", async () => {
  const { root, dependency } = await fixture();
  const first = await installedContentIdentity(root, "dist");
  expect(await installedContentIdentity(root, "dist")).toBe(first);
  await writeFile(join(dependency, "engine.js"), "export const engine = 2;");
  const second = await installedContentIdentity(root, "dist");
  expect(second).not.toBe(first);
  await writeFile(join(dependency, "native.node"), Buffer.from([0, 1, 2]));
  expect(await installedContentIdentity(root, "dist")).not.toBe(second);
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "engine",
      version: "1.0.0",
      dependencies: { nested: "1" },
    }),
  );
  await mkdir(join(dependency, "node_modules", "nested"), { recursive: true });
  await writeFile(
    join(dependency, "node_modules", "nested", "package.json"),
    JSON.stringify({ name: "nested", version: "1.0.0" }),
  );
  const nested = join(dependency, "node_modules", "nested", "asset");
  await writeFile(nested, "before");
  const third = await installedContentIdentity(root, "dist");
  await writeFile(nested, "after");
  expect(await installedContentIdentity(root, "dist")).not.toBe(third);
});
it("represents absent optional dependencies but rejects missing required dependencies and content links", async () => {
  const { root, dependency } = await fixture();
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({
      name: "engine",
      optionalDependencies: { absent: "1" },
      peerDependencies: { peer: "1" },
      peerDependenciesMeta: { peer: { optional: true } },
    }),
  );
  expect(await installedContentIdentity(root, "dist")).toMatch(
    /^[a-f0-9]{64}$/,
  );
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({ name: "engine", dependencies: { absent: "1" } }),
  );
  await expect(installedContentIdentity(root, "dist")).rejects.toThrow();
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({ name: "engine" }),
  );
  await symlink(join(root, "package.json"), join(dependency, "external"));
  await expect(installedContentIdentity(root, "dist")).rejects.toThrow();
});
it("includes installed packages whose name also identifies a Node builtin", async () => {
  const { root, dependency } = await fixture();
  await writeFile(
    join(dependency, "package.json"),
    JSON.stringify({ name: "engine", dependencies: { punycode: "2" } }),
  );
  const nested = join(dependency, "node_modules", "punycode");
  await mkdir(nested, { recursive: true });
  await writeFile(
    join(nested, "package.json"),
    JSON.stringify({ name: "punycode", version: "2.3.1" }),
  );
  const first = await installedContentIdentity(root, "dist");
  await writeFile(join(nested, "implementation.js"), "changed");
  expect(await installedContentIdentity(root, "dist")).not.toBe(first);
});
