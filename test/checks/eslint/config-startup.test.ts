import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

test("default policy validation defers engine loading while explicit rule options still receive pinned validation", () => {
  const result = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import {createRequire} from 'node:module';
    const require = createRequire(import.meta.url);
    const {configFileSchema} = await import('./dist/config/schema.js');
    const {resolveConfig} = await import('./dist/config/profiles.js');
    const parsed = configFileSchema.parse({schemaVersion:1});
    resolveConfig(parsed);
    const eager = Object.keys(require.cache).filter(path => /node_modules[\\\\/]eslint[\\\\/]/u.test(path));
    const invalid = configFileSchema.safeParse({schemaVersion:1,checks:{lint:{rules:{eqeqeq:['error','invalid-mode']}}}});
    console.log(JSON.stringify({eager, valid:invalid.success, issue:invalid.success ? null : invalid.error.issues[0]}));
  `,
    ],
    {
      cwd: fileURLToPath(new URL("../../../", import.meta.url)),
      encoding: "utf8",
      env: { ...process.env, NODE_OPTIONS: "", NODE_PATH: "" },
    },
  );
  const parsed = JSON.parse(result);
  expect(parsed.eager).toEqual([]);
  expect(parsed.valid).toBe(false);
  expect(parsed.issue.path).toEqual(["checks", "lint", "rules", "eqeqeq"]);
});
