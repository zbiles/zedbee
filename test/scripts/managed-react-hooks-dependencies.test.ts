import { createRequire } from "node:module";
import {
  realpathSync,
  readFileSync,
  mkdtempSync,
  mkdirSync,
  copyFileSync,
  symlinkSync,
  rmSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { ESLint } from "eslint";
import { describe, it, expect, onTestFinished } from "vitest";
const require = createRequire(import.meta.url);
const runtimeNames = [
  "@babel/core",
  "@babel/parser",
  "hermes-parser",
  "zod-validation-error",
  "zod",
] as const;

describe("private Hooks runtime dependencies in nested installations", () => {
  it("pins every external runtime import as a direct Swarm dependency", () => {
    const manifest = JSON.parse(readFileSync("package.json", "utf8"));
    const lock = JSON.parse(readFileSync("package-lock.json", "utf8"));
    for (const name of runtimeNames) {
      expect(manifest.dependencies[name], name).toBe(
        lock.packages[`node_modules/${name}`].version,
      );
      expect(lock.packages[""].dependencies[name], name).toBe(
        manifest.dependencies[name],
      );
    }
  });

  it.each(["development", "production"])(
    "loads and lints in %s with only Swarm direct dependencies beside a nested original plugin",
    async (mode) => {
      const root = mkdtempSync(join(tmpdir(), "hooks-nested-runtime-"));
      onTestFinished(() => rmSync(root, { recursive: true, force: true }));
      const swarm = join(root, "node_modules/zedbee");
      const privateRoot = join(swarm, "dist/vendor/react-hooks/7.1.1");
      mkdirSync(privateRoot, { recursive: true });
      for (const name of ["index.cjs", "development.cjs", "production.cjs"])
        copyFileSync(
          `assets/react-hooks/7.1.1/${name}`,
          join(privateRoot, name),
        );
      // Original plugin can resolve its own private dependencies; the copied
      // compiler must resolve independently from Swarm's declared direct roots.
      const original = join(swarm, "node_modules/eslint-plugin-react-hooks");
      mkdirSync(original, { recursive: true });
      for (const name of runtimeNames) {
        const packageRoot = realpathSync(join("node_modules", name));
        const nested = join(original, "node_modules", name);
        mkdirSync(dirname(nested), { recursive: true });
        symlinkSync(packageRoot, nested, "junction");
      }
      const manifest = JSON.parse(readFileSync("package.json", "utf8"));
      for (const name of runtimeNames.filter(
        (name) => manifest.dependencies[name] !== undefined,
      )) {
        const destination = join(swarm, "node_modules", name);
        mkdirSync(dirname(destination), { recursive: true });
        symlinkSync(
          realpathSync(join("node_modules", name)),
          destination,
          "junction",
        );
      }
      const previous = process.env.NODE_ENV;
      let plugin;
      try {
        process.env.NODE_ENV = mode;
        plugin = require(join(privateRoot, "index.cjs"));
      } finally {
        if (previous === undefined) delete process.env.NODE_ENV;
        else process.env.NODE_ENV = previous;
      }
      const engine = new ESLint({
        overrideConfigFile: true,
        overrideConfig: [
          {
            plugins: { "react-hooks": plugin },
            rules: { "react-hooks/set-state-in-effect": "error" },
          },
        ],
      });
      const results = await engine.lintText(
        'import {useEffect,useState} from "react"; export function Example(){ const [x,setX]=useState(0); useEffect(()=>{setX(1);},[]); return x; }',
        { filePath: "example.js" },
      );
      expect(
        results
          .flatMap((result) => result.messages)
          .some(
            (message) => message.ruleId === "react-hooks/set-state-in-effect",
          ),
      ).toBe(true);
    },
  );
});
