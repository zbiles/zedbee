import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("managed binary notices", () => {
  it("summarizes both managed engines in deterministic core notices", async () => {
    const { generateThirdPartyNotices } = (await import(
      pathToFileURL(resolve(root, "scripts/check-production-licenses.mjs")).href
    )) as {
      generateThirdPartyNotices(root: string): Promise<string>;
    };
    const notices = await generateThirdPartyNotices(root);
    expect(notices).toContain("Gitleaks@8.28.0 (managed executable)");
    expect(notices).toContain("License: MIT");
    expect(notices).toContain("OSV-Scanner@2.4.0 (managed executable)");
    expect(notices).toContain("License: Apache-2.0");
    expect(notices).toContain("@zedbee/gitleaks-* platform package");
    expect(notices).toContain("@zedbee/osv-scanner-* platform package");
  });

  it("ships the complete applicable upstream terms in every platform package", async () => {
    const central = JSON.parse(
      await readFile(
        resolve(root, "packages/managed-binary/manifest.json"),
        "utf8",
      ),
    ) as { entries: Array<{ engine: string; packageName: string }> };
    for (const entry of central.entries) {
      const directory = entry.packageName.replace("@zedbee/", "");
      const license = await readFile(
        resolve(root, "packages", directory, "LICENSE"),
        "utf8",
      );
      const notice = await readFile(
        resolve(root, "packages", directory, "THIRD_PARTY_NOTICES.md"),
        "utf8",
      );
      if (entry.engine === "gitleaks") {
        expect(license).toContain("MIT License");
        expect(notice).toContain("Gitleaks 8.28.0");
      } else {
        expect(license).toContain("Apache License");
        expect(notice).toContain("OSV-Scanner 2.4.0");
      }
    }
  });
});
