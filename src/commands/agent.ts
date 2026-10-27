import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  unlink,
} from "node:fs/promises";
import { join } from "node:path";
import { GitClient } from "../git/client.js";

export interface AgentCommandOptions {
  readonly cwd: string;
  readonly install?: "codex" | "claude";
  readonly yes: boolean;
}
export interface AgentCommandIO {
  writeStdout(value: string): void;
  writeStderr(value: string): void;
}

async function state(path: string) {
  try {
    return await lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function executeAgentCommand(
  options: AgentCommandOptions,
  io: AgentCommandIO,
): Promise<0 | 1 | 2> {
  try {
    // The source and compiled module have the same depth in the package.
    const workflow = await readFile(
      new URL("../../plugins/swarm/references/scan.md", import.meta.url),
      "utf8",
    );
    // Keep the standalone skill name while sharing the plugin's maintained workflow.
    const contents = workflow.replace(/^name: scan$/mu, "name: zedbee");
    if (options.install === undefined) {
      io.writeStdout(contents);
      return 0;
    }
    const root = await realpath(
      (await new GitClient(options.cwd).run(["rev-parse", "--show-toplevel"]))
        .stdout,
    );
    const segments = [
      options.install === "codex" ? ".agents" : ".claude",
      "skills",
      "zedbee",
    ];
    const relativePath = `${segments.join("/")}/SKILL.md`;
    let parent = root;
    for (const segment of segments) {
      parent = join(parent, segment);
      const metadata = await state(parent);
      if (
        metadata !== undefined &&
        (metadata.isSymbolicLink() || !metadata.isDirectory())
      )
        throw new Error("Unsafe skill directory");
    }
    const destination = join(parent, "SKILL.md");
    const existing = await state(destination);
    if (existing !== undefined) {
      if (existing.isSymbolicLink() || !existing.isFile())
        throw new Error("Unsafe skill file");
      if ((await readFile(destination, "utf8")) === contents) {
        io.writeStdout(
          `Zedbee agent skill is already installed at ${relativePath}.\n`,
        );
        return 0;
      }
      io.writeStderr(
        `Existing ${relativePath} was preserved. Review it before replacing the skill.\n`,
      );
      return 1;
    }
    if (!options.yes) {
      io.writeStdout(
        `Create ${relativePath}\nRun zedbee agent --install ${options.install} --yes to install the workflow.\n`,
      );
      return 0;
    }
    // Revalidate each directory as it is created; never follow a repository symlink.
    parent = root;
    for (const segment of segments) {
      parent = join(parent, segment);
      await mkdir(parent).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const metadata = await lstat(parent);
      if (
        metadata.isSymbolicLink() ||
        !metadata.isDirectory() ||
        (await realpath(parent)) !== parent
      )
        throw new Error("Unsafe skill directory");
    }
    const temporary = join(parent, `.zedbee-agent-${randomUUID()}.tmp`);
    const handle = await open(temporary, "wx", 0o644);
    try {
      await handle.writeFile(contents, "utf8");
      await handle.sync();
      await handle.close();
      // Publish complete bytes without replacing a file created after our preview.
      await link(temporary, destination);
    } finally {
      await handle.close().catch(() => undefined);
      await unlink(temporary);
    }
    io.writeStdout(`Installed ${relativePath}. The Git index is unchanged.\n`);
    return 0;
  } catch {
    io.writeStderr(
      "Zedbee could not safely prepare the agent skill. Run installation in a Git repository and check the skill destination.\n",
    );
    return 2;
  }
}
