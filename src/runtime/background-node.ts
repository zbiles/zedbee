import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export function launchBackgroundNode(
  entry: URL,
  env: Readonly<Record<string, string | undefined>>,
): void {
  const child = spawn(process.execPath, [fileURLToPath(entry)], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
    env: { ...env },
  });
  child.on("error", () => {});
  child.unref();
}
