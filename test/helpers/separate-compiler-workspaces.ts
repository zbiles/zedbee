import { CHECK_IDS } from "../../src/config/schema.js";
import { createGitRepository } from "./git-repository.js";

export const compilerWorkspaceNames = ["web", "extension", "e2e"] as const;
export const compilerChecks = Object.fromEntries(
  CHECK_IDS.map((id) => [
    id,
    ["lint", "types", "secrets"].includes(id) ? "error" : "off",
  ]),
);

export async function createSeparateCompilerWorkspaces(
  files: Readonly<Record<string, string>> = {},
) {
  const repo = await createGitRepository("zedbee-separate-compiler-");
  await repo.write(".gitignore", "node_modules/\n");
  await repo.write(
    ".zedbeerc.jsonc",
    JSON.stringify({ schemaVersion: 1, checks: compilerChecks }),
  );
  for (const name of compilerWorkspaceNames) {
    const manifest = {
      name,
      version: "1.0.0",
      private: true,
      dependencies: name === "web" ? {} : { "fixture-package": "1.0.0" },
    };
    await repo.write(`${name}/package.json`, JSON.stringify(manifest));
    await repo.write(
      `${name}/package-lock.json`,
      JSON.stringify({
        name,
        lockfileVersion: 3,
        packages: {
          "": manifest,
          ...(name === "web"
            ? {}
            : { "node_modules/fixture-package": { version: "1.0.0" } }),
        },
      }),
    );
    await repo.write(
      `${name}/tsconfig.json`,
      JSON.stringify({
        compilerOptions: {
          module: "ESNext",
          moduleResolution: "Bundler",
          resolveJsonModule: true,
          types: [],
          strict: true,
          noEmit: true,
        },
        include: ["src"],
      }),
    );
    await repo.write(
      `${name}/src/index.ts`,
      name === "web"
        ? "export const value = 1;\n"
        : 'export { value } from "fixture-package";\n',
    );
  }
  for (const [path, contents] of Object.entries(files))
    await repo.write(path, contents);
  await repo.commitAll("separately locked compiler workspaces");
  return repo;
}
