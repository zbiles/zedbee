import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { replaceAnalysis } from "../../scripts/generate-managed-react-hooks.mjs";
const digest = (s: string) => createHash("sha256").update(s).digest("hex");
const region =
  "function validateNoSetStateInEffects() {}\nfunction getSetStateCall() {}\n";
const input = region + "function validateNoJSXInTryStatement() {}";
describe("managed Hooks patch generation", () => {
  it("replaces only the verified analysis region deterministically", () => {
    const result = replaceAnalysis(
      input,
      "replacement\n",
      digest(input),
      digest(region),
    );
    expect(result).toBe(
      "replacement\nfunction validateNoJSXInTryStatement() {}",
    );
    expect(
      replaceAnalysis(input, "replacement\n", digest(input), digest(region)),
    ).toBe(result);
  });
  it("rejects altered input and altered replacement boundaries", () => {
    expect(() =>
      replaceAnalysis(input + "x", "", digest(input), digest(region)),
    ).toThrow(/input/u);
    expect(() => replaceAnalysis(input, "", digest(input), "wrong")).toThrow(
      /region/u,
    );
  });
  it("rejects duplicate or missing regions", () => {
    for (const source of ["", input + input]) {
      expect(() =>
        replaceAnalysis(source, "", digest(source), digest(region)),
      ).toThrow(/boundar/u);
    }
  });
});

import {
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { afterEach } from "vitest";
import { generateManagedHooks } from "../../scripts/generate-managed-react-hooks.mjs";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "hooks-generation-"));
  roots.push(root);
  for (const path of [
    "package.json",
    "package-lock.json",
    "patches/react-hooks/7.1.1/inputs.json",
    "patches/react-hooks/7.1.1/analysis.js",
    "node_modules/eslint-plugin-react-hooks/package.json",
    "node_modules/eslint-plugin-react-hooks/LICENSE",
    "node_modules/eslint-plugin-react-hooks/cjs/eslint-plugin-react-hooks.development.js",
    "node_modules/eslint-plugin-react-hooks/cjs/eslint-plugin-react-hooks.production.js",
  ]) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(path, join(root, path));
  }
  mkdirSync(join(root, "src/checks/react"), { recursive: true });
  return root;
}
it("generates byte-identical files and checks without writing", () => {
  const root = fixture();
  generateManagedHooks(root, true);
  const file = join(root, "assets/react-hooks/7.1.1/provenance.json");
  const original = readFileSync(file);
  const modified = statSync(file).mtimeMs;
  generateManagedHooks(root, false);
  expect(statSync(file).mtimeMs).toBe(modified);
  generateManagedHooks(root, true);
  expect(readFileSync(file)).toEqual(original);
});
it("rejects a mismatched upstream version", () => {
  const root = fixture();
  const file = join(
    root,
    "node_modules/eslint-plugin-react-hooks/package.json",
  );
  const manifest = JSON.parse(readFileSync(file, "utf8"));
  manifest.version = "0.0.0";
  writeFileSync(file, JSON.stringify(manifest));
  expect(() => generateManagedHooks(root, true)).toThrow(/version/u);
});
it("rejects corrupt generated output and a missing production variant", () => {
  const root = fixture();
  generateManagedHooks(root, true);
  writeFileSync(
    join(root, "assets/react-hooks/7.1.1/development.cjs"),
    "corrupt",
  );
  expect(() => generateManagedHooks(root, false)).toThrow(/Stale/u);
  generateManagedHooks(root, true);
  unlinkSync(join(root, "assets/react-hooks/7.1.1/production.cjs"));
  expect(() => generateManagedHooks(root, false)).toThrow();
});
