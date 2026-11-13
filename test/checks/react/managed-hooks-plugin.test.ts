import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  copyFileSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { describe, it, expect, afterEach } from "vitest";
import { verifyManagedHooksAssets } from "../../../src/checks/react/managed-hooks-plugin.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hooks-assets-"));
  roots.push(root);
  for (const file of [
    "index.cjs",
    "development.cjs",
    "production.cjs",
    "LICENSE",
    "provenance.json",
  ])
    copyFileSync(`assets/react-hooks/7.1.1/${file}`, join(root, file));
  const digest = createHash("sha256")
    .update(readFileSync(join(root, "provenance.json")))
    .digest("hex");
  return { root, url: pathToFileURL(root + "/"), digest };
}
describe("managed Hooks runtime integrity", () => {
  it("accepts exact artifacts", () => {
    const f = fixture();
    expect(() => verifyManagedHooksAssets(f.url, f.digest)).not.toThrow();
  });
  it("rejects corrupt provenance before loading code", () => {
    const f = fixture();
    writeFileSync(join(f.root, "provenance.json"), "{}");
    expect(() => verifyManagedHooksAssets(f.url, f.digest)).toThrow(
      /provenance/u,
    );
  });
  it.each(["index.cjs", "development.cjs", "production.cjs", "LICENSE"])(
    "rejects altered %s",
    (file) => {
      const f = fixture();
      writeFileSync(join(f.root, file), "corrupt");
      expect(() => verifyManagedHooksAssets(f.url, f.digest)).toThrow(
        /artifact/u,
      );
    },
  );
});
