import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { expect, it } from "vitest";
import {
  installPackedFixture,
  sharedPackedTarball,
} from "../helpers/packed-install.js";

const root = resolve(import.meta.dirname, "../..");

it.each([".", "web"])(
  "preserves app React, React DOM and Zod when installing packed Zedbee in %s",
  async (folder) => {
    const scratch = await mkdtemp(
      join(tmpdir(), "zedbee-react-zod-isolation-"),
    );
    const project = join(scratch, folder);
    try {
      await mkdir(project, { recursive: true });
      const npmOptions = {
        cwd: project,
        stdin: "ignore" as const,
        env: { npm_config_cache: join(scratch, "npm-cache") },
      };
      const pack = async (directory: string) => {
        const packed = await execa(
          "npm",
          [
            "pack",
            directory,
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            scratch,
          ],
          npmOptions,
        );
        return join(scratch, JSON.parse(packed.stdout)[0].filename as string);
      };
      const tarball = sharedPackedTarball()?.path ?? (await pack(root));
      const fixtures = [
        ["react", "react-19-2-0", "^19.2.0"],
        ["react-dom", "react-dom-19-2-0", "^19.2.0"],
        ["zod", "zod-4-1-12", "^4.1.12"],
        ["scheduler", "scheduler", "^0.27.0"],
      ] as const;
      const packed = await Promise.all(
        fixtures.map(([, alias]) => pack(join(root, "node_modules", alias))),
      );
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ name: "app-consumer", private: true }),
      );
      await execa(
        "npm",
        [
          "install",
          "--offline",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          ...packed,
        ],
        npmOptions,
      );
      const manifest = JSON.parse(
        await readFile(join(project, "package.json"), "utf8"),
      );
      const lock = JSON.parse(
        await readFile(join(project, "package-lock.json"), "utf8"),
      );
      for (const [name, , range] of fixtures) {
        manifest.dependencies[name] = range;
        lock.packages[""].dependencies[name] = range;
      }
      await writeFile(join(project, "package.json"), JSON.stringify(manifest));
      await writeFile(join(project, "package-lock.json"), JSON.stringify(lock));
      const appVersions = {
        react: "19.2.0",
        "react-dom": "19.2.0",
        zod: "4.1.12",
      };
      for (const [name, version] of Object.entries(appVersions))
        expect(lock.packages[`node_modules/${name}`].version).toBe(version);
      const before = Object.fromEntries(
        Object.entries(lock.packages).filter(([path]) => path !== ""),
      );
      await installPackedFixture(
        tarball,
        root,
        project,
        join(scratch, "install-cache"),
        { reuseSharedInstall: false },
      );
      const installedLock = JSON.parse(
        await readFile(join(project, "package-lock.json"), "utf8"),
      );
      // Preserve all existing app lock entries, including React DOM's scheduler.
      for (const [path, entry] of Object.entries(before))
        expect.soft(installedLock.packages[path], path).toEqual(entry);
      const managed = join(project, "node_modules/zedbee");
      const zedbee = JSON.parse(
        await readFile(join(managed, "package.json"), "utf8"),
      );
      // An app's Knip must not supply the managed engine's diagnostic/cache identity.
      await mkdir(join(project, "node_modules/knip"), { recursive: true });
      await writeFile(
        join(project, "node_modules/knip/package.json"),
        JSON.stringify({ name: "knip", version: "999.0.0", main: "index.js" }),
      );
      await writeFile(join(project, "node_modules/knip/index.js"), "");
      for (const name of ["react", "zod"]) {
        const bundled = JSON.parse(
          await readFile(
            join(managed, "node_modules", name, "package.json"),
            "utf8",
          ),
        );
        expect(bundled.version).toBe(zedbee.dependencies[name]);
      }
      // Exercise the app's renderer and schema, then Zedbee's own React hooks and Ink.
      const probe = `
      import assert from 'node:assert/strict';
      import { createRequire } from 'node:module';
      import { join } from 'node:path';
      import { pathToFileURL } from 'node:url';
      import { PassThrough } from 'node:stream';
      const app = createRequire(join(process.cwd(), 'package.json'));
      const appReact = app('react');
      assert.equal(appReact.version, '19.2.0');
      assert.equal(app('react-dom/server').renderToString(appReact.createElement('span', null, 'app works')), '<span>app works</span>');
      assert.equal(app('zod').z.string().parse('app works'), 'app works');
      const own = createRequire(join(process.cwd(), 'node_modules/zedbee/dist/cli.js'));
      const ownReact = own('react');
      assert.equal(ownReact.version, ${JSON.stringify(zedbee.dependencies.react)});
      const inkPath = own.resolve('ink');
      const inkRequire = createRequire(inkPath);
      assert.equal(inkRequire.resolve('react'), own.resolve('react'));
      const reconcilerRequire = createRequire(inkRequire.resolve('react-reconciler'));
      assert.equal(reconcilerRequire.resolve('react'), own.resolve('react'));
      const { managedKnipEntry } = await import(pathToFileURL(join(process.cwd(), 'node_modules/zedbee/dist/checks/dead-code/managed-knip.js')));
      const { readInstalledPackageVersion, observationCacheEngineIdentity } = await import(pathToFileURL(join(process.cwd(), 'node_modules/zedbee/dist/checks/engine-identity.js')));
      assert.equal(readInstalledPackageVersion('knip'), ${JSON.stringify(zedbee.vendoredDependencies.knip)});
      assert.ok(observationCacheEngineIdentity('deadCode').startsWith('knip@' + ${JSON.stringify(zedbee.vendoredDependencies.knip)} + '+'));
      const knipRequire = createRequire(managedKnipEntry);
      await import(pathToFileURL(knipRequire.resolve('oxc-parser')));
      assert.equal(knipRequire.resolve('zod'), own.resolve('zod'));
      const { render, Text } = await import(pathToFileURL(inkPath));
      const output = new PassThrough();
      let text = '';
      output.on('data', data => text += data.toString());
      function Component() { const [value] = ownReact.useState('Zedbee works'); return ownReact.createElement(Text, null, value); }
      const session = render(ownReact.createElement(Component), { stdout: output, stderr: output, stdin: new PassThrough(), debug: true, exitOnCtrlC: false, patchConsole: false });
      session.unmount();
      await session.waitUntilExit();
      assert.match(text, /Zedbee works/);
    `;
      await writeFile(join(project, "probe.mjs"), probe);
      await execa(process.execPath, ["probe.mjs"], { cwd: project });
      const help = await execa(
        process.execPath,
        [join(managed, "dist/cli.js"), "--help"],
        { cwd: project },
      );
      expect(help.stdout).toContain("Diff-aware pre-commit scanning");
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  },
);
