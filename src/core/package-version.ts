import { readFileSync } from "node:fs";

function packageVersion(): string {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as unknown;
  if (
    typeof manifest !== "object" ||
    manifest === null ||
    !("version" in manifest) ||
    typeof manifest.version !== "string" ||
    manifest.version.trim() === ""
  ) {
    throw new TypeError("Zedbee package metadata has no valid version.");
  }
  return manifest.version;
}

export const ZEDBEE_VERSION = packageVersion();
