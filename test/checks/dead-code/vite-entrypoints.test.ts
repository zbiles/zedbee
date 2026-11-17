import { expect, it } from "vitest";
import { createInspectionFixture } from "../../inspection/fixture.js";
import { inspectRepository } from "../../../src/inspection/inspect-repository.js";
import { createManagedKnipConfig } from "../../../src/checks/dead-code/managed-config.js";

it.each(["main.ts", "start.tsx", "boot.js", "custom.mjs"])(
  "roots HTML module %s while leaving unrelated sources ordinary",
  async (name) => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", {
      name: "web",
      devDependencies: { vite: "7" },
    });
    await f.write(
      "index.html",
      `<!-- <script type=module src='/src/orphan.ts'></script> --><SCRIPT SRC='/src/${name}?v=1#boot' TYPE='m&#111;dule'></SCRIPT>`,
    );
    await f.write(`src/${name}`, "console.log('start');");
    await f.write("src/orphan.ts", "export const unused = 1;");
    const inspection = await inspectRepository(f.root);
    const config = await createManagedKnipConfig(
      inspection.snapshotRoot,
      inspection,
    );
    expect(config.workspaces["."]?.entry).toEqual([`src/${name}`]);
    expect(config.workspaces["."]?.ignoreDependencies).toEqual(["vite"]);
  },
);

it("partitions explicit HTML and source entries by their owning workspace", async () => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", { name: "root", workspaces: ["web"] });
  await f.writeJson("web/package.json", { name: "web" });
  await f.write(
    "web/pages/other.html",
    '<script src="../src/boot.ts" type=module></script>',
  );
  await f.write("web/src/boot.ts", "console.log(1);");
  await f.write("web/src/library.ts", "export const value=1;");
  const inspection = await inspectRepository(f.root);
  const config = await createManagedKnipConfig(
    inspection.snapshotRoot,
    inspection,
    undefined,
    undefined,
    ["web/pages/other.html", "web/src/library.ts"],
  );
  expect(config.workspaces.web?.entry).toEqual([
    "src/boot.ts",
    "src/library.ts",
  ]);
  expect(config.workspaces["."]?.entry).toEqual([]);
});

it.each([
  '<script type=module src="/src/missing.ts"></script>',
  '<script type=module>import "/src/main.ts"</script>',
  '<script type=module src="/%2e%2e/escape.ts"></script>',
  '<script type=module src="/src/main.ts?raw"></script>',
  '<base href="/custom/"><script type=module src="src/main.ts"></script>',
])(
  "reports unsupported or broken application references clearly: %s",
  async (html) => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", {
      name: "web",
      devDependencies: { vite: "7" },
    });
    await f.write("index.html", html);
    await f.write("src/main.ts", "console.log(1);");
    const inspection = await inspectRepository(f.root);
    await expect(
      createManagedKnipConfig(inspection.snapshotRoot, inspection),
    ).rejects.toMatchObject({
      code: "DEAD_CODE_ENTRYPOINT_UNSUPPORTED",
      path: "index.html",
    });
  },
);

it("ignores remote URLs, comments, templates, and duplicate later attributes without inventing entries", async () => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", {
    name: "web",
    devDependencies: { vite: "7" },
  });
  await f.write(
    "index.html",
    '<template><script type=module src="/src/orphan.ts"></script></template><script type=module src="https://cdn.invalid/x.js"></script><script type=module src="data:text/javascript,alert(1)"></script><script type=module src="/src/main.ts" src="/src/orphan.ts"></script>',
  );
  await f.write("src/main.ts", "console.log(1);");
  await f.write("src/orphan.ts", "console.log(2);");
  const inspection = await inspectRepository(f.root);
  expect(
    (await createManagedKnipConfig(inspection.snapshotRoot, inspection))
      .workspaces["."]?.entry,
  ).toEqual(["src/main.ts"]);
});

it("supports explicit sources for custom roots and inline modules without guessing their HTML URL base", async () => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", {
    name: "web",
    devDependencies: { vite: "7" },
  });
  await f.write("vite.config.ts", 'export default {root:"custom"};');
  await f.write(
    "index.html",
    '<script type=module>import "/src/virtual.js"</script>',
  );
  await f.write("src/custom.ts", "console.log(1);");
  const inspection = await inspectRepository(f.root);
  expect(
    (
      await createManagedKnipConfig(
        inspection.snapshotRoot,
        inspection,
        undefined,
        undefined,
        ["src/custom.ts"],
      )
    ).workspaces["."]?.entry,
  ).toEqual(["src/custom.ts", "vite.config.ts"]);
});

it("reports oversized HTML before parsing", async () => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", {
    name: "web",
    devDependencies: { vite: "7" },
  });
  await f.write("index.html", " ".repeat(256 * 1024 + 1));
  const inspection = await inspectRepository(f.root);
  await expect(
    createManagedKnipConfig(inspection.snapshotRoot, inspection),
  ).rejects.toMatchObject({
    code: "DEAD_CODE_ENTRYPOINT_UNSUPPORTED",
    path: "index.html",
  });
});

it("allows contained source aliases but rejects canonical cross-workspace entry aliases", async () => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", {
    name: "root",
    workspaces: ["web", "other"],
  });
  for (const name of ["web", "other"]) {
    await f.writeJson(`${name}/package.json`, {
      name,
      devDependencies: { vite: "7" },
    });
    await f.write(`${name}/src/main.ts`, "console.log(1);");
  }
  await f.symlink("main.ts", "web/src/alias.ts");
  await f.write(
    "web/index.html",
    '<script type=module src="/src/alias.ts"></script>',
  );
  let inspection = await inspectRepository(f.root);
  expect(
    (await createManagedKnipConfig(inspection.snapshotRoot, inspection))
      .workspaces.web?.entry,
  ).toEqual(["src/alias.ts", "src/main.ts"]);
  await f.symlink("../../other/src/main.ts", "web/src/cross.ts");
  await f.write(
    "web/index.html",
    '<script type=module src="/src/cross.ts"></script>',
  );
  inspection = await inspectRepository(f.root);
  await expect(
    createManagedKnipConfig(inspection.snapshotRoot, inspection),
  ).rejects.toMatchObject({
    code: "DEAD_CODE_ENTRYPOINT_UNSUPPORTED",
    path: "web/index.html",
  });
});

it.each(["missing.ts", "outside.md", "../outside.ts"])(
  "rejects unusable explicit path %s",
  async (path) => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", { name: "web" });
    await f.write("outside.md", "hello");
    const inspection = await inspectRepository(f.root);
    await expect(
      createManagedKnipConfig(
        inspection.snapshotRoot,
        inspection,
        undefined,
        undefined,
        [path],
      ),
    ).rejects.toThrow();
  },
);

it("keeps shadowed Vite configurations ordinary source", async () => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", {
    name: "web",
    devDependencies: { vite: "7" },
  });
  await f.write("vite.config.js", "export default {};");
  await f.write("vite.config.ts", "export default {};");
  const inspection = await inspectRepository(f.root);
  expect(
    (await createManagedKnipConfig(inspection.snapshotRoot, inspection))
      .workspaces["."]?.entry,
  ).toEqual(["vite.config.js"]);
});

it("leaves non-module script types ordinary and diagnoses vite-ignore modules", async () => {
  const f = await createInspectionFixture();
  await f.writeJson("package.json", {
    name: "web",
    devDependencies: { vite: "7" },
  });
  await f.write(
    "index.html",
    '<script type="MODULE" src="/src/main.ts"></script>',
  );
  await f.write("src/main.ts", "console.log(1);");
  let inspection = await inspectRepository(f.root);
  expect(
    (await createManagedKnipConfig(inspection.snapshotRoot, inspection))
      .workspaces["."]?.entry,
  ).toEqual([]);
  await f.write(
    "index.html",
    '<script vite-ignore type=module src="/src/main.ts"></script>',
  );
  inspection = await inspectRepository(f.root);
  await expect(
    createManagedKnipConfig(inspection.snapshotRoot, inspection),
  ).rejects.toMatchObject({
    code: "DEAD_CODE_ENTRYPOINT_UNSUPPORTED",
    path: "index.html",
  });
});

it.each([
  'const root="custom"; export default {root};',
  'export default {["root"]:"custom"};',
  'import build from "./build.js"; export default {build};',
  'const settings={root:"custom"}; export default {...settings};',
  'export {default} from "./custom-config.js";',
  'import settings from "./custom-config.js"; export default settings;',
  "export default () => computeSettings();",
])(
  "diagnoses statically opaque Vite configuration unless sources are explicit: %s",
  async (source) => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", {
      name: "web",
      devDependencies: { vite: "7" },
    });
    await f.write("vite.config.ts", source);
    await f.write("src/start.ts", "console.log(1);");
    const inspection = await inspectRepository(f.root);
    await expect(
      createManagedKnipConfig(inspection.snapshotRoot, inspection),
    ).rejects.toMatchObject({
      code: "DEAD_CODE_ENTRYPOINT_UNSUPPORTED",
      path: "vite.config.ts",
    });
    expect(
      (
        await createManagedKnipConfig(
          inspection.snapshotRoot,
          inspection,
          undefined,
          undefined,
          ["src/start.ts"],
        )
      ).workspaces["."]?.entry,
    ).toEqual(["src/start.ts", "vite.config.ts"]);
  },
);

it.each(["raw", "url", "worker", "sharedworker", "inline"])(
  "uses explicit sources to cover unsupported HTML %s loading",
  async (modifier) => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", {
      name: "web",
      devDependencies: { vite: "7" },
    });
    await f.write(
      "index.html",
      `<script type=module src="/src/start.ts?${modifier}"></script><script type=module src="/src/other.ts"></script>`,
    );
    await f.write("src/start.ts", "console.log(1);");
    await f.write("src/other.ts", "console.log(2);");
    const inspection = await inspectRepository(f.root);
    await expect(
      createManagedKnipConfig(inspection.snapshotRoot, inspection),
    ).rejects.toMatchObject({
      code: "DEAD_CODE_ENTRYPOINT_UNSUPPORTED",
      path: "index.html",
    });
    expect(
      (
        await createManagedKnipConfig(
          inspection.snapshotRoot,
          inspection,
          undefined,
          undefined,
          ["src/start.ts"],
        )
      ).workspaces["."]?.entry,
    ).toEqual(["src/other.ts", "src/start.ts"]);
  },
);

it.each([
  "module.exports = getSettings();",
  'module.exports = {}; module.exports.root = "custom";',
  'module["exports"] = {}; module["exports"]["root"] = "custom";',
  'exports.root = "custom";',
])(
  "requires explicit source fallback for CommonJS configuration: %s",
  async (source) => {
    const f = await createInspectionFixture();
    await f.writeJson("package.json", {
      name: "web",
      devDependencies: { vite: "7" },
    });
    await f.write("vite.config.cjs", source);
    await f.write("src/start.ts", "console.log(1);");
    const inspection = await inspectRepository(f.root);
    await expect(
      createManagedKnipConfig(inspection.snapshotRoot, inspection),
    ).rejects.toMatchObject({
      code: "DEAD_CODE_ENTRYPOINT_UNSUPPORTED",
      path: "vite.config.cjs",
    });
  },
);
