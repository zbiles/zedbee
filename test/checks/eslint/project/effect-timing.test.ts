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
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";
import { runProjectEslint } from "../../../../src/checks/eslint/project/engine.js";
import { requireProjectEslintTrust } from "../../../../src/checks/eslint/project/trust.js";

const sourceRoot = fileURLToPath(new URL("../../../..", import.meta.url));
const rule = "react-hooks/set-state-in-effect";
const code = (
  before: boolean,
  wrapper: boolean,
) => `import {useState,useEffect,useCallback} from 'react';
export function useExample(){const[v,setV]=useState(0);const read=useCallback(async()=>{${before ? "setV(1);" : ""}await Promise.resolve();${before ? "" : "setV(1);"}},[]);useEffect(()=>{${wrapper ? "void(async()=>{await read()})()" : "void read().then(()=>{})"}},[read]);return v}`;

it("preserves native project Hooks behavior and omitted-rule coverage", async () => {
  const scratch = await realpath(
    await mkdtemp(join(tmpdir(), "zedbee-native-hooks-")),
  );
  onTestFinished(() => rm(scratch, { recursive: true, force: true }));
  const snapshotRoot = join(scratch, "snapshot"),
    checkoutRoot = join(scratch, "live");
  await mkdir(snapshotRoot);
  const versions: Record<string, string> = {};
  for (const name of ["eslint", "eslint-plugin-react-hooks"]) {
    const manifest = JSON.parse(
      await readFile(
        join(sourceRoot, "node_modules", name, "package.json"),
        "utf8",
      ),
    );
    versions[name] = manifest.version;
  }
  await writeFile(
    join(snapshotRoot, "package.json"),
    JSON.stringify({
      name: "native-hooks",
      type: "module",
      devDependencies: versions,
    }),
  );
  await writeFile(
    join(snapshotRoot, "package-lock.json"),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { devDependencies: versions },
        ...Object.fromEntries(
          Object.entries(versions).map(([name, version]) => [
            `node_modules/${name}`,
            { version },
          ]),
        ),
      },
    }),
  );
  const config = (enabled: boolean) =>
    `import hooks from 'eslint-plugin-react-hooks';export default[{plugins:{'react-hooks':hooks},rules:${enabled ? JSON.stringify({ [rule]: "error" }) : "{}"}}];`;
  await writeFile(join(snapshotRoot, "eslint.config.mjs"), config(true));
  await writeFile(join(snapshotRoot, "value.js"), code(false, false));
  await cp(snapshotRoot, checkoutRoot, { recursive: true });
  await mkdir(join(checkoutRoot, "node_modules"));
  for (const name of Object.keys(versions))
    await symlink(
      join(sourceRoot, "node_modules", name),
      join(checkoutRoot, "node_modules", name),
    );
  const permit = await requireProjectEslintTrust(checkoutRoot, ".", true);
  const own = createRequire(join(checkoutRoot, "package.json"));
  const { ESLint } = own("eslint") as typeof import("eslint");
  for (const [before, wrapper, enabled, shouldReport] of [
    [false, false, true, true],
    [true, true, true, false],
    [true, false, false, false],
  ] as const) {
    await writeFile(join(snapshotRoot, "value.js"), code(before, wrapper));
    await writeFile(join(snapshotRoot, "eslint.config.mjs"), config(enabled));
    const original = own("eslint-plugin-react-hooks");
    const direct = new ESLint({
      cwd: checkoutRoot,
      overrideConfigFile: true,
      overrideConfig: [
        {
          plugins: { "react-hooks": original },
          rules: enabled ? { [rule]: "error" } : {},
        },
      ],
    });
    const native = (
      await direct.lintText(code(before, wrapper), { filePath: "value.js" })
    )
      .flatMap((result) => result.messages)
      .filter((message) => message.ruleId === rule);
    const throughSwarm = await runProjectEslint({
      checkoutRoot,
      snapshotRoot,
      projectRoot: ".",
      files: ["value.js"],
      permit,
      signal: new AbortController().signal,
      messages: "redacted",
      allowSourceMessages: false,
    });
    const diagnostics = throughSwarm.diagnostics.filter(
      (diagnostic) => diagnostic.ruleId === rule,
    );
    expect(diagnostics.map((d) => d.severity)).toEqual(
      native.map((d) => d.severity),
    );
    expect(diagnostics.length > 0).toBe(shouldReport);
    expect(throughSwarm.checkedFiles).toEqual(["value.js"]);
  }
});
