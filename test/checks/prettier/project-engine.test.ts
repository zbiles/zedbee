import { describe, expect, it, onTestFinished } from "vitest";
import { createProjectPrettierFixture } from "../../helpers/project-prettier.js";

describe("project Prettier engine", () => {
  it("uses index config rather than an unstaged edit", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(".prettierrc.json", '{"singleQuote":true}');
    await fixture.write("value.ts", 'export const value = "hello";\n');
    await fixture.stage(".prettierrc.json", "value.ts");
    await fixture.write(".prettierrc.json", '{"singleQuote":false}');

    const session = await fixture.open({ source: "index", trust: true });

    await expect(
      session.format("value.ts", 'export const value = "hello";'),
    ).resolves.toEqual({
      kind: "formatted",
      text: "export const value = 'hello';\n",
    });
  });

  it("does not execute a config without consent", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      "prettier.config.mjs",
      "import { writeFileSync } from 'node:fs';\n" +
        "writeFileSync(new URL('./MARKER_EXECUTED', import.meta.url), 'executed');\n" +
        "throw new Error('CONFIG_EXECUTED');\n",
    );
    await fixture.stage("prettier.config.mjs");

    await expect(
      fixture.open({ source: "index", trust: false }),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_TRUST_REQUIRED" });
    expect(await fixture.markerExists()).toBe(false);
  });

  it("committed inputs win over a conflicting staged config", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(".prettierrc.json", '{"singleQuote":true}');
    await fixture.write("value.ts", 'export const value = "hello";\n');
    await fixture.commit();
    await fixture.write(".prettierrc.json", '{"singleQuote":false}');
    await fixture.stage(".prettierrc.json");

    const session = await fixture.open({ source: "commit", trust: true });

    await expect(
      session.format("value.ts", 'export const value = "hello";'),
    ).resolves.toEqual({
      kind: "formatted",
      text: "export const value = 'hello';\n",
    });
  });

  it("does not substitute bundled formatting for a missing plugin", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      ".prettierrc.json",
      '{"plugins":["missing-fixture-plugin"]}',
    );
    await fixture.write("value.ts", "export const value = 1;\n");
    await fixture.stage(".prettierrc.json", "value.ts");

    const session = await fixture.open({ source: "index", trust: true });

    await expect(
      session.format("value.ts", "export const value = 1;"),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_PLUGIN_MISSING" });
  });

  it("retires its worker on close", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(".prettierrc.json", "{}");
    await fixture.write("value.ts", "export const value = 1;\n");
    await fixture.stage(".prettierrc.json", "value.ts");

    const session = await fixture.open({ source: "index", trust: true });
    await session.close();
    await expect(
      session.format("value.ts", "export const value = 1;"),
    ).rejects.toMatchObject({ code: "PROJECT_PRETTIER_WORKER_FAILED" });
  });

  it("imports representable values from a consented executable config", async () => {
    const fixture = await createProjectPrettierFixture();
    onTestFinished(() => fixture.dispose());
    await fixture.write(
      "prettier.config.mjs",
      "export default {" +
        " singleQuote: true," +
        " printWidth: 100," +
        " overrides: [{ files: '*.md', options: { printWidth: 80 } }]," +
        " plugins: []" +
        " };\n",
    );
    await fixture.stage("prettier.config.mjs");

    const session = await fixture.open({ source: "index", trust: true });
    const imported = await session.readConfigForImport("prettier.config.mjs");

    expect(imported.settings).toMatchObject({
      singleQuote: true,
      printWidth: 100,
    });
    expect(imported.overrides).toEqual([
      {
        files: "*.md",
        settings: { printWidth: 80 },
      },
    ]);
  });
});
