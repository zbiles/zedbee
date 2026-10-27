import { spawnSync } from "node:child_process";
import { constants } from "node:fs";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
export const PLUGIN_FILES = Object.freeze([
  "plugin.json",
  ".claude-plugin/plugin.json",
  "LICENSE",
  "README.md",
  "assets/icon.svg",
  "references/cli-release.json",
  "references/setup.md",
  "references/scan.md",
  "scripts/download-cli.mjs",
  ...["scan", "fix", "doctor"].map((name) => `skills/${name}/SKILL.md`),
]);
export function claudeManifest(manifest) {
  const { extensions, $schema, ...identity } = manifest;
  return {
    ...identity,
    displayName: extensions["com.openai"].interface.displayName,
    icon: extensions["com.openai"].interface.logo,
    documentationUrl: "https://zedbee.dev/docs",
    supportUrl: `${manifest.repository}/issues`,
    privacyPolicyUrl: extensions["com.openai"].interface.privacyPolicyURL,
    termsOfServiceUrl: extensions["com.openai"].interface.termsOfServiceURL,
  };
}
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
async function pluginFile(root, path) {
  const expectedRoot = join(await realpath(root), "plugins/swarm");
  const pluginRoot = await realpath(expectedRoot);
  if (pluginRoot !== expectedRoot) throw new Error("Unsafe plugin directory.");
  const candidate = join(pluginRoot, path);
  const fromRoot = relative(pluginRoot, await realpath(candidate));
  if (
    isAbsolute(fromRoot) ||
    fromRoot === ".." ||
    fromRoot.startsWith(`..${sep}`) ||
    (await lstat(candidate)).isSymbolicLink() ||
    !(await lstat(candidate)).isFile()
  )
    throw new Error("Unsafe plugin file.");
  return candidate;
}
export async function checkPlugin(root = ROOT, { write = false } = {}) {
  root = await realpath(root);
  const pluginRoot = join(root, "plugins/swarm");
  const manifest = JSON.parse(
    await readFile(await pluginFile(root, "plugin.json"), "utf8"),
  );
  if (
    manifest.name !== "swarm" ||
    !/^\d+\.\d+\.\d+$/.test(manifest.version) ||
    !manifest.description ||
    manifest.license !== "PolyForm-Small-Business-1.0.0" ||
    manifest.extensions?.["com.openai"]?.requires_local_executor !== true
  )
    throw new Error("Invalid Swarm plugin metadata.");
  const presentation = manifest.extensions["com.openai"].interface;
  for (const [field, limit] of [
    ["displayName", 30],
    ["shortDescription", 30],
    ["longDescription", 4000],
    ["developerName", 80],
  ]) {
    if (
      typeof presentation[field] !== "string" ||
      !presentation[field].trim() ||
      presentation[field].length > limit
    )
      throw new Error(`Invalid plugin listing field: ${field}`);
  }
  if (
    !Array.isArray(presentation.defaultPrompt) ||
    presentation.defaultPrompt.length > 3 ||
    presentation.defaultPrompt.some(
      (value) => typeof value !== "string" || value.length > 128,
    )
  )
    throw new Error("Invalid plugin starter prompts.");
  for (const field of ["logo", "composerIcon"]) {
    if (presentation[field] !== "./assets/icon.svg")
      throw new Error(`Invalid plugin icon: ${field}`);
  }
  if (
    manifest.extensions["com.openai"].onboardingSkill !==
    "./skills/scan/SKILL.md"
  )
    throw new Error("Invalid plugin onboarding skill.");
  const generated = {
    ".claude-plugin/plugin.json": json(claudeManifest(manifest)),
    LICENSE: await readFile(join(root, "LICENSE"), "utf8"),
  };
  for (const [path, content] of Object.entries(generated)) {
    if (write) {
      // Never follow a checked-in generated-file symlink.
      const target = join(pluginRoot, path);
      await mkdir(dirname(target), { recursive: true });
      try {
        if ((await lstat(target)).isSymbolicLink())
          throw new Error("Unsafe generated plugin file.");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      if ((await realpath(dirname(target))) !== dirname(target))
        throw new Error("Unsafe generated plugin directory.");
      await writeFile(target, content);
    }
    if ((await readFile(await pluginFile(root, path), "utf8")) !== content)
      throw new Error(`Generated plugin file is stale: ${path}`);
  }
  for (const path of PLUGIN_FILES) await pluginFile(root, path);
  return manifest;
}
export async function preparePlugin(outputDirectory, root = ROOT) {
  root = await realpath(root);
  const manifest = await checkPlugin(root);
  const output = await realpath(resolve(outputDirectory));
  const staging = await mkdtemp(join(tmpdir(), "zedbee-plugin-package-"));
  try {
    for (const path of PLUGIN_FILES) {
      await mkdir(dirname(join(staging, path)), { recursive: true });
      await copyFile(await pluginFile(root, path), join(staging, path));
    }
    const archive = join(output, `swarm-${manifest.version}.zip`);
    try {
      await lstat(archive);
      throw new Error(
        "Plugin archive already exists; preserve the existing artifact.",
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const stagedArchive = join(staging, "swarm.zip");
    const result = spawnSync(
      "zip",
      ["-X", "-q", stagedArchive, ...PLUGIN_FILES],
      {
        cwd: staging,
        encoding: "utf8",
      },
    );
    if (result.error || result.status !== 0)
      throw new Error(
        "Could not create the Swarm plugin archive; zip is required.",
      );
    await copyFile(stagedArchive, archive, constants.COPYFILE_EXCL);
    return { archive, version: manifest.version, files: [...PLUGIN_FILES] };
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  try {
    const [operation, output, ...extra] = process.argv.slice(2);
    if (
      extra.length ||
      (operation === "--pack" ? !output : output !== undefined) ||
      !["--check", "--write", "--pack"].includes(operation)
    )
      throw new Error(
        "Use --check, --write, or --pack <existing-output-directory>.",
      );
    if (operation === "--pack")
      console.log(JSON.stringify(await preparePlugin(output)));
    else {
      await checkPlugin(ROOT, { write: operation === "--write" });
      console.log("Swarm plugin metadata and package files are valid.");
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
