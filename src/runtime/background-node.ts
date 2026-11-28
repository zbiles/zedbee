import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export function launchBackgroundNode(
  entry: URL,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const path = fileURLToPath(entry);
  const child = spawn(process.execPath, [path], {
    cwd: dirname(path),
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...env },
  });
  child.on("error", () => {});
  child.unref();
}
