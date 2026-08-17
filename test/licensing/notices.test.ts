import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../..");

describe("third-party notices", () => {
  it("derives notices from npm dependencies without managed executable sections", async () => {
    const { generateThirdPartyNotices } = (await import(
      pathToFileURL(resolve(root, "scripts/check-production-licenses.mjs")).href
    )) as {
      generateThirdPartyNotices(root: string): Promise<string>;
    };

    const notices = await generateThirdPartyNotices(root);

    expect(notices).toContain("@secretlint/core@13.0.4");
    expect(notices).toContain("License: MIT");
    expect(notices).not.toContain("managed executable");
    expect(notices).not.toContain("@zedbee/gitleaks-");
    expect(notices).not.toContain("@zedbee/osv-scanner-");
  });
});
