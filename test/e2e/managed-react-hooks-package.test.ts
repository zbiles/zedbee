import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import {
  installPackedFixture,
  sharedPackedTarball,
} from "../helpers/packed-install.js";

const root = resolve(import.meta.dirname, "../..");

it("runs the corrected managed Hooks rule from the installed tarball in both environments", async () => {
  const scratch = await mkdtemp(join(tmpdir(), "zedbee-hooks-package-"));
  try {
    const project = join(scratch, "consumer");
    await mkdir(project);
    await writeFile(
      join(project, "package.json"),
      JSON.stringify({ name: "hooks-consumer", private: true }),
    );
    let tarball = sharedPackedTarball()?.path;
    if (!tarball) {
      const packed = await execa(
        "npm",
        [
          "pack",
          root,
          "--json",
          "--ignore-scripts",
          "--pack-destination",
          scratch,
        ],
        { cwd: root, env: { npm_config_cache: join(scratch, "pack-cache") } },
      );
      tarball = join(scratch, JSON.parse(packed.stdout)[0].filename as string);
    }
    await installPackedFixture(
      tarball,
      root,
      project,
      join(scratch, "npm-cache"),
    );
    const probe = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      const packageRoot = join(process.cwd(), 'node_modules/zedbee');
      const own = createRequire(join(packageRoot, 'package.json'));
      const { createManagedEslint } = await import(pathToFileURL(join(packageRoot, 'dist/checks/eslint/load-engine.js')));
      const engine = createManagedEslint({cwd:process.cwd(),mode:'react-correctness',reactVersion:'19.0.0',managedIgnores:[]});
      const source = (before, wrapper) => 'import {useState,useEffect,useCallback} from "react";export function useExample(){const [v,setV]=useState(0);const read=useCallback(async()=>{'+(before?'setV(1);':'')+'await Promise.resolve();'+(!before?'setV(1);':'')+'},[]);useEffect(()=>{'+(wrapper?'void(async()=>{await read()})()':'void read().then(()=>{})')+'},[read]);return v}';
      const rule = 'react-hooks/set-state-in-effect';
      for (const wrapper of [false,true]) for (const before of [false,true]) {
        const results=await engine.lintText(source(before,wrapper),{filePath:'src/example.tsx'});
        assert.equal(results.some(r=>r.messages.some(m=>m.fatal)),false);
        const findings=results.flatMap(r=>r.messages).filter(m=>m.ruleId===rule);
        assert.equal(findings.length>0,before,JSON.stringify({before,wrapper,findings}));
      }
      // The correction must not mutate the original package object used by a project.
      const original = own('eslint-plugin-react-hooks');
      const { ESLint } = own('eslint');
      const native = new ESLint({cwd:process.cwd(),overrideConfigFile:true,overrideConfig:[{plugins:{'react-hooks':original},rules:{[rule]:'error'}}]});
      const nativeSafe=await native.lintText(source(false,false),{filePath:'example.js'});
      assert.ok(nativeSafe.flatMap(r=>r.messages).some(m=>m.ruleId===rule),'original plugin keeps its known post-await false positive');
      console.log('managed timing and native isolation passed');
    `;
    await writeFile(join(project, "probe.mjs"), probe);
    for (const environment of ["development", "production"]) {
      const result = await execa(process.execPath, ["probe.mjs"], {
        cwd: project,
        env: { NODE_ENV: environment },
      });
      expect(result.stdout).toContain(
        "managed timing and native isolation passed",
      );
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
});
