import { lstat, mkdir, readFile, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GitClient } from "../../src/git/client.js";
import * as prettier from "prettier";
import { createInspectionFixture } from "../inspection/fixture.js";
import {
  evaluateExecutableProjectConfigs,
  resolveFormattingSetup,
} from "../../src/init/formatter-setup.js";
import { verifyExecutableImportProvenance } from "../../src/init/import-provenance.js";
import * as workspaceModule from "../../src/checks/prettier/project-workspace.js";
import * as engine from "../../src/checks/prettier/project-engine.js";

const prettierRoot = fileURLToPath(
  new URL("../../node_modules/prettier", import.meta.url),
);
async function fixture(dependencies: Record<string, string> = {}) {
  const fixture = await createInspectionFixture();
  await fixture.writeJson("package.json", {
    name: "fixture",
    devDependencies: { prettier: "^3.0.0", ...dependencies },
  });
  await mkdir(join(fixture.root, "node_modules"), { recursive: true });
  await symlink(
    prettierRoot,
    join(fixture.root, "node_modules/prettier"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return fixture;
}
async function evaluate(root: string, signal = new AbortController().signal) {
  const setup = await resolveFormattingSetup(root);
  return evaluateExecutableProjectConfigs(
    root,
    setup.imported,
    setup.executableTargets,
    signal,
  );
}

describe("consented import capture and provenance", () => {
  it("rejects A-derived settings when the original config changes to B during evaluation", async () => {
    const f = await fixture();
    const path = join(f.root, "prettier.config.cjs");
    await f.write(
      "prettier.config.cjs",
      `require('node:fs').writeFileSync(${JSON.stringify(path)}, 'module.exports={semi:true}');module.exports={semi:false};`,
    );
    await expect(evaluate(f.root)).rejects.toThrow(/configuration inputs/u);
    expect(await readFile(path, "utf8")).toBe("module.exports={semi:true}");
  });

  it("binds the captured root and refuses an imported helper edit before apply", async () => {
    const f = await fixture();
    const source = "module.exports=require('./helper.cjs');";
    await f.write("prettier.config.cjs", source);
    await f.write("helper.cjs", "module.exports={semi:false};");
    const result = await evaluate(f.root);
    expect(result.imported.settings.semi).toBe(false);
    expect(result.evaluatedConfigs[0]?.sha256).toBe(
      createHash("sha256").update(source).digest("hex"),
    );
    await verifyExecutableImportProvenance(f.root, result.evaluatedConfigs);
    await f.write("helper.cjs", "module.exports={semi:true};");
    await expect(
      verifyExecutableImportProvenance(f.root, result.evaluatedConfigs),
    ).rejects.toThrow(/changed after the preview/u);
  });

  it("freezes external shared packages, traverses declared transitive dependencies and detects their edits", async () => {
    const f = await fixture({ "shared-config": "1" });
    const external = await createInspectionFixture();
    await external.writeJson("shared/package.json", {
      name: "shared-config",
      main: "index.cjs",
      dependencies: { "helper-config": "1" },
    });
    await external.write(
      "shared/index.cjs",
      "module.exports=require('helper-config');",
    );
    await external.writeJson("node_modules/helper-config/package.json", {
      name: "helper-config",
      main: "index.cjs",
    });
    await external.write(
      "node_modules/helper-config/index.cjs",
      "module.exports={semi:false};",
    );
    await f.symlink(
      join(external.root, "shared"),
      "node_modules/shared-config",
    );
    await f.write(".prettierrc.json", '"shared-config"');
    const result = await evaluate(f.root);
    expect(result.imported.settings.semi).toBe(false);
    await verifyExecutableImportProvenance(f.root, result.evaluatedConfigs);
    await external.write(
      "node_modules/helper-config/index.cjs",
      "module.exports={semi:true};",
    );
    await expect(
      verifyExecutableImportProvenance(f.root, result.evaluatedConfigs),
    ).rejects.toThrow(/changed after the preview/u);
  });

  it("invalidates apply when a previously missing optional package is installed or removed", async () => {
    const f = await fixture({ "shared-config": "1" });
    await f.write(".prettierrc.json", '"shared-config"');
    await f.writeJson("node_modules/shared-config/package.json", {
      name: "shared-config",
      main: "index.cjs",
      optionalDependencies: { "optional-config": "1" },
    });
    await f.write(
      "node_modules/shared-config/index.cjs",
      "try{module.exports=require('optional-config')}catch{module.exports={semi:false}}",
    );
    const before = await evaluate(f.root);
    await f.writeJson("node_modules/optional-config/package.json", {
      name: "optional-config",
      main: "index.cjs",
    });
    await f.write(
      "node_modules/optional-config/index.cjs",
      "module.exports={semi:true};",
    );
    await expect(
      verifyExecutableImportProvenance(f.root, before.evaluatedConfigs),
    ).rejects.toThrow(/changed after the preview/u);
    const after = await evaluate(f.root);
    expect(after.imported.settings.semi).toBe(true);
    await rm(join(f.root, "node_modules/optional-config"), { recursive: true });
    await expect(
      verifyExecutableImportProvenance(f.root, after.evaluatedConfigs),
    ).rejects.toThrow(/changed after the preview/u);
  });

  it("copies one tree and starts one worker for several config scopes in the same project", async () => {
    const f = await fixture();
    await f.write("prettier.config.cjs", "module.exports={semi:false};");
    await f.write(
      "src/prettier.config.cjs",
      "module.exports={singleQuote:true};",
    );
    await new GitClient(f.root).run(["init"]);
    // Neither Git metadata nor cache content is part of the imported inputs.
    await f.symlink("/does-not-exist", ".git/ignored-link");
    await f.symlink("/does-not-exist", ".cache/ignored-link");
    const capture = vi.spyOn(workspaceModule, "createProjectWorkspace");
    const worker = vi.spyOn(engine, "openProjectFormatter");
    try {
      const result = await evaluate(f.root);
      expect(result.evaluatedConfigs).toHaveLength(2);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(worker).toHaveBeenCalledTimes(1);
      expect(result.evaluatedConfigs[0]?.capture).toBe(
        result.evaluatedConfigs[1]?.capture,
      );
    } finally {
      capture.mockRestore();
      worker.mockRestore();
    }
  });

  it.each(["cjs", "json"])(
    "matches native relative shared %s configuration",
    async (extension) => {
      const f = await fixture();
      await f.write(".prettierrc.json", `"./config/shared.${extension}"`);
      await f.write(
        `config/shared.${extension}`,
        extension === "cjs" ? "module.exports={semi:false};" : '{"semi":false}',
      );
      const native = await prettier.resolveConfig(join(f.root, "index.js"));
      expect((await evaluate(f.root)).imported.settings).toEqual(native);
    },
  );

  it("loads relative JSON shared config in the built plain Node worker", async () => {
    const f = await fixture();
    await f.write(".prettierrc.json", '"./config/shared.json"');
    await f.write("config/shared.json", '{"semi":false}');
    const built = await import("../../dist/init/formatter-setup.js");
    const setup = await built.resolveFormattingSetup(f.root);
    const result = await built.evaluateExecutableProjectConfigs(
      f.root,
      setup.imported,
      setup.executableTargets,
      new AbortController().signal,
    );
    expect(result.imported.settings.semi).toBe(false);
  });

  it("resolves package references from the containing nested config directory", async () => {
    const f = await fixture({ "shared-config": "1" });
    await f.writeJson("node_modules/shared-config/package.json", {
      name: "shared-config",
      main: "index.cjs",
    });
    await f.write(
      "node_modules/shared-config/index.cjs",
      "module.exports={semi:true};",
    );
    await f.writeJson("src/node_modules/shared-config/package.json", {
      name: "shared-config",
      main: "index.cjs",
    });
    await f.write(
      "src/node_modules/shared-config/index.cjs",
      "module.exports={semi:false};",
    );
    await f.write("src/.prettierrc.json", '"shared-config"');
    const native = await prettier.resolveConfig(join(f.root, "src/index.js"));
    expect(native?.semi).toBe(false);
    const result = await evaluate(f.root);
    expect(result.imported.overrides[0]?.settings.semi).toBe(false);
  });

  it("retains contained config symlink topology and native dist helper imports", async () => {
    const f = await fixture();
    await f.write(
      "config/prettier.cjs",
      "module.exports=require('./dist/helper.cjs');",
    );
    await f.write("config/dist/helper.cjs", "module.exports={semi:false};");
    await f.symlink("config/prettier.cjs", ".prettierrc.cjs");
    expect((await prettier.resolveConfig(join(f.root, "index.js")))?.semi).toBe(
      false,
    );
    expect((await evaluate(f.root)).imported.settings.semi).toBe(false);
  });

  it("refuses relative references escaping the consented tree", async () => {
    const f = await fixture();
    await f.write(".prettierrc.json", '"../../outside.cjs"');
    await expect(evaluate(f.root)).rejects.toMatchObject({
      code: "PROJECT_PRETTIER_CONFIG_INVALID",
    });
  });

  it("removes a shared capture when execution is cancelled", async () => {
    const f = await fixture();
    const marker = join(f.root, "started");
    await f.write(
      "prettier.config.cjs",
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'yes');while(true){}`,
    );
    const controller = new AbortController();
    const capture = vi.spyOn(workspaceModule, "createProjectWorkspace");
    try {
      const pending = evaluate(f.root, controller.signal);
      const outcome = expect(pending).rejects.toThrow(/cancelled/u);
      await vi.waitFor(
        async () => expect(await readFile(marker, "utf8")).toBe("yes"),
        { timeout: 10_000, interval: 10 },
      );
      controller.abort();
      await outcome;
      const workspace = (await capture.mock.results[0]!
        .value) as workspaceModule.ProjectWorkspace;
      await expect(lstat(workspace.root)).rejects.toThrow();
    } finally {
      controller.abort();
      capture.mockRestore();
    }
  });
});
