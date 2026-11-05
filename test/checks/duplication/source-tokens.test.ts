import { describe, expect, it } from "vitest";
import { realpath } from "node:fs/promises";
import { captureSnapshotRegistry } from "../../../src/inspection/snapshot-registry.js";
import { loadDuplicationSources } from "../../../src/checks/duplication/source-tokens.js";
import { createInspectionFixture } from "../../inspection/fixture.js";

const settings = { minLines: 5, minTokens: 50, mode: "mild" as const };
const signal = new AbortController().signal;
async function tokenize(file: string, text: string) {
  const fixture = await createInspectionFixture();
  await fixture.write(file, text);
  const registry = await captureSnapshotRegistry(await realpath(fixture.root));
  return (await loadDuplicationSources(registry, [file], settings, signal)).get(
    file,
  )!;
}
describe("contained duplication source evidence", () => {
  it.each([
    [
      "src/a.js",
      'const a = /a\\/b/.test(value); const b = value / 2; const s = "// text";',
    ],
    ["src/a.ts", "const x: string = `part ${value / 2} end`;"],
    ["src/a.jsx", "const x = <div>hello // text {value / 2}</div>;"],
    ["src/a.tsx", "const x: JSX.Element = <div>{`hello ${value}`}</div>;"],
  ])("preserves significant lexical text in %s", async (file, source) => {
    const original = await tokenize(file, source);
    const withComment = await tokenize(file, `/* comment */\n${source}`);
    expect(original.valid).toBe(true);
    expect(original.tokens.map(({ kind, text }) => [kind, text])).toEqual(
      withComment.tokens.map(({ kind, text }) => [kind, text]),
    );
    expect(original.tokens.map(({ text }) => text).join("")).toContain(
      file.endsWith("jsx")
        ? "hello // text"
        : file.endsWith("js")
          ? "/a\\/b/"
          : "value",
    );
  });
  it.each(["/** explanation */", "/** @type {number} */"])(
    "excludes JSDoc from significant tokens: %s",
    async (comment) => {
      const before = await tokenize(
        "src/a.js",
        "function f() { const value = 1; return value; }",
      );
      const after = await tokenize(
        "src/a.js",
        `function f() {\n ${comment}\n const value = 1; return value; }`,
      );
      expect(after.tokens.map(({ kind, text }) => [kind, text])).toEqual(
        before.tokens.map(({ kind, text }) => [kind, text]),
      );
    },
  );
  it("does not treat malformed source as equivalent evidence", async () => {
    expect((await tokenize("src/a.ts", "const x = ;")).valid).toBe(false);
  });
  it("rejects paths outside the contained snapshot and honours cancellation", async () => {
    const fixture = await createInspectionFixture();
    await fixture.write("src/a.ts", "const x = 1;");
    const registry = await captureSnapshotRegistry(
      await realpath(fixture.root),
    );
    await expect(
      loadDuplicationSources(registry, ["../outside.ts"], settings, signal),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      loadDuplicationSources(
        registry,
        ["src/a.ts"],
        settings,
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
