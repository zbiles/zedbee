import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it, onTestFinished } from "vitest";
import { runProjectEslint } from "../../../../src/checks/eslint/project/engine.js";
import {
  requireProjectEslintTrust,
  persistProjectEslintTrust,
  revokeProjectEslintTrust,
} from "../../../../src/checks/eslint/project/trust.js";
import { parseProjectEslintResult } from "../../../../src/checks/eslint/project/protocol.js";

const run = promisify(execFile);
const source = fileURLToPath(new URL("../../../..", import.meta.url));
async function fixture(
  config = "export default [{rules:{'no-undef':'warn'}}];",
) {
  const root = await realpath(
    await mkdtemp(join(tmpdir(), "zedbee-eslint-test-")),
  );
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  const checkoutRoot = join(root, "live"),
    snapshotRoot = join(root, "snapshot");
  const put = async (root: string, path: string, content: string) => {
    await mkdir(dirname(join(root, path)), { recursive: true });
    await writeFile(join(root, path), content);
  };
  await put(
    snapshotRoot,
    "package.json",
    JSON.stringify({
      name: "fixture",
      type: "module",
      devDependencies: { eslint: "9.39.5" },
    }),
  );
  await put(
    snapshotRoot,
    "package-lock.json",
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: { eslint: "9.39.5" } },
        "node_modules/eslint": { version: "9.39.5" },
      },
    }),
  );
  await put(snapshotRoot, "eslint.config.mjs", config);
  await put(snapshotRoot, "value.js", "missing();\n");
  await cp(snapshotRoot, checkoutRoot, { recursive: true });
  await mkdir(join(checkoutRoot, "node_modules"));
  await symlink(
    join(source, "node_modules/eslint"),
    join(checkoutRoot, "node_modules/eslint"),
  );
  const permit = await requireProjectEslintTrust(checkoutRoot, ".", true);
  const input = {
    checkoutRoot,
    snapshotRoot,
    projectRoot: ".",
    files: ["value.js"],
    permit,
    signal: new AbortController().signal,
    messages: "redacted" as const,
    allowSourceMessages: false,
  };
  return { root, checkoutRoot, snapshotRoot, input, put };
}

async function addInstalledDependency(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
) {
  const manifest = JSON.parse(
    await readFile(join(f.snapshotRoot, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    await readFile(join(f.snapshotRoot, "package-lock.json"), "utf8"),
  );
  const installed = JSON.parse(
    await readFile(join(source, "node_modules", name, "package.json"), "utf8"),
  );
  manifest.devDependencies[name] = installed.version;
  lock.packages[""].devDependencies[name] = installed.version;
  lock.packages[`node_modules/${name}`] = { version: installed.version };
  await f.put(f.snapshotRoot, "package.json", JSON.stringify(manifest));
  await f.put(f.snapshotRoot, "package-lock.json", JSON.stringify(lock));
  await mkdir(dirname(join(f.checkoutRoot, "node_modules", name)), {
    recursive: true,
  });
  await symlink(
    join(source, "node_modules", name),
    join(f.checkoutRoot, "node_modules", name),
  );
}

it("runs the installed type-aware TypeScript engine on captured tsconfig", async () => {
  const f = await fixture(
    "import ts from 'typescript-eslint';export default [{files:['**/*.ts'],languageOptions:{parser:ts.parser,parserOptions:{project:'./tsconfig.json',tsconfigRootDir:import.meta.dirname}},plugins:{'@typescript-eslint':ts.plugin},rules:{'@typescript-eslint/no-floating-promises':'error'}}];",
  );
  await addInstalledDependency(f, "typescript-eslint");
  await f.put(
    f.snapshotRoot,
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: { target: "ES2022", strict: true },
      include: ["value.ts"],
    }),
  );
  await f.put(
    f.snapshotRoot,
    "value.ts",
    "async function value(){return 1;}\nvalue();\n",
  );
  const result = await runProjectEslint({ ...f.input, files: ["value.ts"] });
  expect(result.diagnostics).toMatchObject([
    { ruleId: "@typescript-eslint/no-floating-promises", severity: 2, line: 2 },
  ]);
});

it("runs installed JSX accessibility rules without applying managed patches", async () => {
  const f = await fixture(
    "import a11y from 'eslint-plugin-jsx-a11y';export default [{files:['**/*.jsx'],languageOptions:{parserOptions:{ecmaFeatures:{jsx:true}}},plugins:{'jsx-a11y':a11y},rules:{'jsx-a11y/alt-text':'warn'}}];",
  );
  await addInstalledDependency(f, "eslint-plugin-jsx-a11y");
  await f.put(
    f.snapshotRoot,
    "value.jsx",
    "export const value=<img src='a.png'/>;\n",
  );
  expect(
    (await runProjectEslint({ ...f.input, files: ["value.jsx"] })).diagnostics,
  ).toMatchObject([{ ruleId: "jsx-a11y/alt-text", severity: 1 }]);
});

it("preserves ancestor flat-config file globs from a nested workspace", async () => {
  const f = await fixture(
    "export default [{files:['packages/app/*.js'],rules:{'no-undef':'warn'}}];",
  );
  await f.put(
    f.snapshotRoot,
    "packages/app/package.json",
    JSON.stringify({ name: "app", type: "module" }),
  );
  await f.put(f.snapshotRoot, "packages/app/value.js", "missing();\n");
  const permit = await requireProjectEslintTrust(
    f.checkoutRoot,
    "packages/app",
    true,
  );
  const result = await runProjectEslint({
    ...f.input,
    permit,
    projectRoot: "packages/app",
    files: ["packages/app/value.js"],
  });
  expect(result.diagnostics).toMatchObject([
    { file: "packages/app/value.js", ruleId: "no-undef", severity: 1 },
  ]);
});

it("analyzes captured source and local config imports with native severity", async () => {
  const f = await fixture(
    "import config from './base.mjs';export default config;",
  );
  await f.put(
    f.snapshotRoot,
    "base.mjs",
    "export default [{rules:{'no-undef':'warn'}}];",
  );
  await f.put(
    f.checkoutRoot,
    "base.mjs",
    "throw new Error('UNSTAGED SECRET');",
  );
  await f.put(f.checkoutRoot, "value.js", "export const okay=1;");
  const result = await runProjectEslint(f.input);
  expect(result).toMatchObject({
    version: "9.39.5",
    checkedFiles: ["value.js"],
    ignoredFiles: [],
    diagnostics: [
      { file: "value.js", ruleId: "no-undef", severity: 1, line: 1, column: 1 },
    ],
  });
  expect(JSON.stringify(result)).not.toContain("missing");
});

it("rejects oversized captured rule data rather than silently omitting it", async () => {
  const f = await fixture(
    "import fs from 'node:fs';const data={meta:{schema:[]},create(c){return{Program(n){if(fs.existsSync(new URL('./policy-data.json',import.meta.url)))c.report({node:n,message:'captured policy applies'})}}}};export default[{plugins:{local:{rules:{data}}},rules:{'local/data':'error'}}];",
  );
  await writeFile(
    join(f.snapshotRoot, "policy-data.json"),
    Buffer.alloc(33 * 1024 * 1024, 0x20),
  );
  await expect(runProjectEslint(f.input)).rejects.toMatchObject({
    code: "PROJECT_ESLINT_LAYOUT_UNSUPPORTED",
  });
});

it("rejects requested source missing from the captured snapshot before execution", async () => {
  const f = await fixture();
  await expect(
    runProjectEslint({ ...f.input, files: ["absent.js"] }),
  ).rejects.toMatchObject({ code: "PROJECT_ESLINT_LAYOUT_UNSUPPORTED" });
});

it("preserves rule data at the mirror's maximum supported file size", async () => {
  const f = await fixture(
    "import fs from 'node:fs';const data={meta:{schema:[]},create(c){return{Program(n){if(fs.existsSync(new URL('./policy-data.json',import.meta.url)))c.report({node:n,message:'captured policy applies'})}}}};export default[{plugins:{local:{rules:{data}}},rules:{'local/data':'error'}}];",
  );
  await writeFile(
    join(f.snapshotRoot, "policy-data.json"),
    Buffer.alloc(32 * 1024 * 1024, 0x20),
  );
  expect((await runProjectEslint(f.input)).diagnostics).toMatchObject([
    { ruleId: "local/data", severity: 2 },
  ]);
});

it("rejects captured directories the reused mirror cannot reproduce", async () => {
  const f = await fixture();
  await mkdir(join(f.snapshotRoot, "empty-policy-data"));
  await expect(runProjectEslint(f.input)).rejects.toMatchObject({
    code: "PROJECT_ESLINT_LAYOUT_UNSUPPORTED",
  });
});

it("requires an unforgeable execution permit bound to checkout and workspace", async () => {
  const f = await fixture();
  await expect(
    runProjectEslint({ ...f.input, permit: { ...f.input.permit } }),
  ).rejects.toMatchObject({ code: "PROJECT_ESLINT_TRUST_REQUIRED" });
  await expect(
    runProjectEslint({ ...f.input, projectRoot: "nested" }),
  ).rejects.toMatchObject({ code: "PROJECT_ESLINT_TRUST_REQUIRED" });
});

it("keeps full source messages behind a distinct capability", async () => {
  const f = await fixture();
  await expect(
    runProjectEslint({
      ...f.input,
      messages: "full",
      allowSourceMessages: true,
    }),
  ).rejects.toMatchObject({ code: "PROJECT_ESLINT_MESSAGES_TRUST_REQUIRED" });
  const permit = await requireProjectEslintTrust(f.checkoutRoot, ".", true, {
    sourceMessages: true,
  });
  const full = await runProjectEslint({
    ...f.input,
    permit,
    messages: "full",
    allowSourceMessages: true,
  });
  expect(full.diagnostics[0]?.message).toContain("missing");
});

it("persists execution and messages consent separately in local Git config", async () => {
  const f = await fixture();
  await run("git", ["init", "--quiet"], { cwd: f.checkoutRoot });
  await expect(
    requireProjectEslintTrust(f.checkoutRoot, "."),
  ).rejects.toMatchObject({ code: "PROJECT_ESLINT_TRUST_REQUIRED" });
  await persistProjectEslintTrust(f.checkoutRoot, ".", "execute");
  const permit = await requireProjectEslintTrust(f.checkoutRoot, ".");
  await expect(
    runProjectEslint({
      ...f.input,
      permit,
      messages: "full",
      allowSourceMessages: true,
    }),
  ).rejects.toMatchObject({ code: "PROJECT_ESLINT_MESSAGES_TRUST_REQUIRED" });
  await persistProjectEslintTrust(f.checkoutRoot, ".", "messages");
  const allowed = await requireProjectEslintTrust(f.checkoutRoot, ".");
  expect(
    (
      await runProjectEslint({
        ...f.input,
        permit: allowed,
        messages: "full",
        allowSourceMessages: true,
      })
    ).diagnostics[0]?.message,
  ).toContain("missing");
  await revokeProjectEslintTrust(f.checkoutRoot, ".");
  await expect(
    requireProjectEslintTrust(f.checkoutRoot, "."),
  ).rejects.toMatchObject({ code: "PROJECT_ESLINT_TRUST_REQUIRED" });
});

it.each([
  ["throw new Error('PRIVATE SOURCE');", "PROJECT_ESLINT_CONFIG_INVALID"],
  [
    "console.log('PRIVATE SOURCE');console.error('PRIVATE SOURCE');export default [{rules:{'no-undef':'error'}}];",
    null,
  ],
  ["process.exit(27);", "PROJECT_ESLINT_WORKER_FAILED"],
  [
    "export default [{processor:{preprocess:t=>[t],postprocess:m=>m.flat()}}];",
    "PROJECT_ESLINT_CONFIG_UNSUPPORTED",
  ],
])(
  "hides config output and reports execution failures: %s",
  async (config, code) => {
    const f = await fixture(config);
    if (code) {
      await expect(runProjectEslint(f.input)).rejects.toMatchObject({ code });
    } else
      expect(JSON.stringify(await runProjectEslint(f.input))).not.toContain(
        "PRIVATE SOURCE",
      );
  },
);

it("reports ignored coverage rather than inventing a checked file", async () => {
  const f = await fixture("export default [{ignores:['value.js']}];");
  expect(await runProjectEslint(f.input)).toMatchObject({
    checkedFiles: [],
    ignoredFiles: ["value.js"],
    diagnostics: [],
  });
});

it("refuses missing flat config and never executes legacy config", async () => {
  const f = await fixture();
  await rm(join(f.snapshotRoot, "eslint.config.mjs"));
  await f.put(f.snapshotRoot, ".eslintrc.cjs", "throw new Error('PRIVATE');");
  await expect(runProjectEslint(f.input)).rejects.toMatchObject({
    code: "PROJECT_ESLINT_CONFIG_UNSUPPORTED",
  });
});

it("refuses missing selected-checkout installation instead of borrowing ancestors", async () => {
  const f = await fixture();
  await rm(join(f.checkoutRoot, "node_modules/eslint"));
  await expect(runProjectEslint(f.input)).rejects.toMatchObject({
    code: "PROJECT_ESLINT_INSTALL_MISSING",
  });
});

it.each(["manifest", "lock"])(
  "rejects %s requirements inconsistent with installed dependencies",
  async (where) => {
    const f = await fixture();
    if (where === "manifest")
      await f.put(
        f.snapshotRoot,
        "package.json",
        JSON.stringify({ devDependencies: { eslint: "9.38.0" } }),
      );
    else
      await f.put(
        f.snapshotRoot,
        "package-lock.json",
        JSON.stringify({
          lockfileVersion: 3,
          packages: {
            "": { devDependencies: { eslint: "9.39.5" } },
            "node_modules/eslint": { version: "9.38.0" },
          },
        }),
      );
    await expect(runProjectEslint(f.input)).rejects.toMatchObject({
      code: "PROJECT_ESLINT_INSTALL_INCONSISTENT",
    });
  },
);

it("validates baseline execution against explicit target installation requirements", async () => {
  const f = await fixture();
  const baseline = join(f.root, "baseline");
  await cp(f.snapshotRoot, baseline, { recursive: true });
  await f.put(
    baseline,
    "package.json",
    JSON.stringify({ type: "module", devDependencies: { eslint: "9.38.0" } }),
  );
  expect(
    (
      await runProjectEslint({
        ...f.input,
        snapshotRoot: baseline,
        installationSnapshotRoot: f.snapshotRoot,
      })
    ).version,
  ).toBe("9.39.5");
});

it("cancels a hanging config and kills its process tree", async () => {
  const f = await fixture();
  const marker = join(f.root, "pids.json");
  await f.put(
    f.snapshotRoot,
    "eslint.config.mjs",
    `import fs from 'node:fs';import{spawn}from'node:child_process';const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)']);fs.writeFileSync(${JSON.stringify(marker)},JSON.stringify([process.pid,child.pid]));await new Promise(()=>{});export default [];`,
  );
  const controller = new AbortController();
  const promise = runProjectEslint({ ...f.input, signal: controller.signal });
  let pids: number[] = [];
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      pids = JSON.parse(await readFile(marker, "utf8"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  controller.abort();
  await expect(promise).rejects.toMatchObject({
    code: "PROJECT_ESLINT_CANCELLED",
  });
  expect(pids).toHaveLength(2);
  for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
});

it("uses a fresh process for every invocation and leaves no worker alive", async () => {
  const f = await fixture(
    "const pid={meta:{schema:[]},create(c){return{Program(n){c.report({node:n,message:String(process.pid)})}}}};export default[{plugins:{local:{rules:{pid}}},rules:{'local/pid':'error'}}];",
  );
  const permit = await requireProjectEslintTrust(f.checkoutRoot, ".", true, {
    sourceMessages: true,
  });
  const input = {
    ...f.input,
    permit,
    messages: "full" as const,
    allowSourceMessages: true,
  };
  const first = await runProjectEslint(input),
    second = await runProjectEslint(input);
  const pid1 = Number(first.diagnostics[0]?.message),
    pid2 = Number(second.diagnostics[0]?.message);
  expect(pid1).toBeGreaterThan(0);
  expect(pid2).not.toBe(pid1);
  expect(() => process.kill(pid1, 0)).toThrow();
  expect(() => process.kill(pid2, 0)).toThrow();
});

it("accepts a valid reply larger than a pipe buffer", async () => {
  const f = await fixture(
    "const large={meta:{schema:[]},create(c){return{Program(n){for(let i=0;i<5;i++)c.report({node:n,message:'x'.repeat(60000)})}}}};export default[{plugins:{local:{rules:{large}}},rules:{'local/large':'error'}}];",
  );
  const permit = await requireProjectEslintTrust(f.checkoutRoot, ".", true, {
    sourceMessages: true,
  });
  const result = await runProjectEslint({
    ...f.input,
    permit,
    messages: "full",
    allowSourceMessages: true,
  });
  expect(result.diagnostics).toHaveLength(5);
});

it("bounds oversized diagnostic responses", async () => {
  const f = await fixture(
    "const large={meta:{schema:[]},create(c){return {Program(n){c.report({node:n,message:'x'.repeat(2000000)})}}}};export default [{plugins:{local:{rules:{large}}},rules:{'local/large':'error'}}];",
  );
  const permit = await requireProjectEslintTrust(f.checkoutRoot, ".", true, {
    sourceMessages: true,
  });
  await expect(
    runProjectEslint({
      ...f.input,
      permit,
      messages: "full",
      allowSourceMessages: true,
    }),
  ).rejects.toMatchObject({ code: "PROJECT_ESLINT_OUTPUT_LIMIT" });
});

it("rejects nested dependency shadows outside declared workspaces", async () => {
  const f = await fixture(
    "import config from './config/base.mjs';export default config;",
  );
  await f.put(
    f.snapshotRoot,
    "config/base.mjs",
    "export default [{rules:{'no-undef':'warn'}}];",
  );
  await mkdir(join(f.checkoutRoot, "config/node_modules"), { recursive: true });
  await expect(runProjectEslint(f.input)).rejects.toMatchObject({
    code: "PROJECT_ESLINT_LAYOUT_UNSUPPORTED",
  });
});

it("does not turn fatal parse failures into completed diagnostics", async () => {
  const f = await fixture();
  await f.put(f.snapshotRoot, "value.js", "export const = ;");
  await expect(runProjectEslint(f.input)).rejects.toMatchObject({
    code: "PROJECT_ESLINT_CONFIG_INVALID",
  });
});

it("retains source-free comparison identity while messages are redacted", async () => {
  const f = await fixture();
  const result = await runProjectEslint(f.input);
  expect(result.diagnostics[0]?.comparisonIdentity).toMatch(/^[a-f0-9]{64}$/u);
});

it("rejects file traversal before executing project code", async () => {
  const f = await fixture("throw new Error('PRIVATE');");
  await expect(
    runProjectEslint({ ...f.input, files: ["../outside.js"] }),
  ).rejects.toMatchObject({ code: "PROJECT_ESLINT_PROTOCOL_INVALID" });
});

it.each([
  {
    version: "9.39.5",
    diagnostics: [],
    checkedFiles: ["../outside.js"],
    ignoredFiles: [],
  },
  {
    version: "9.39.5",
    diagnostics: [
      {
        file: "value.js",
        ruleId: "\u001b[31mSECRET",
        severity: 2,
        message: "a",
      },
    ],
    checkedFiles: ["value.js"],
    ignoredFiles: [],
  },
  { version: "9.39.5", diagnostics: [], checkedFiles: [], ignoredFiles: [] },
])("rejects invalid/unaccounted worker coverage", (value) => {
  expect(() => parseProjectEslintResult(value, ["value.js"])).toThrow();
});
