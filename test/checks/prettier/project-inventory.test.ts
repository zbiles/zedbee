import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, onTestFinished } from "vitest";
import { collectProjectFormattingInventory } from "../../../src/checks/prettier/project-inventory.js";

describe("project formatting inventory", () => {
  it("uses one deterministic limit across nested directories and reports truncation", async () => {
    const root = await mkdtemp(join(tmpdir(), "zedbee-format-inventory-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "a"), { recursive: true });
    await mkdir(join(root, "b"), { recursive: true });
    await writeFile(join(root, "a", "first.ts"), "first\n");
    await writeFile(join(root, "a", "second.ts"), "second\n");
    await writeFile(join(root, "b", "third.ts"), "third\n");

    await expect(collectProjectFormattingInventory(root, 2)).resolves.toEqual({
      files: ["a/first.ts", "a/second.ts"],
      truncated: true,
    });
  });
});
