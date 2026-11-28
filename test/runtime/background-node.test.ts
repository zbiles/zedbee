import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })));
vi.mock("node:child_process", () => ({ spawn }));

const { launchBackgroundNode } =
  await import("../../src/runtime/background-node.js");

describe("launchBackgroundNode", () => {
  it("runs the worker from its own directory instead of the caller's", () => {
    const entry = new URL("./worker.js", import.meta.url);
    const path = fileURLToPath(entry);

    launchBackgroundNode(entry, { HOME: "/home/user" });

    expect(spawn).toHaveBeenCalledWith(
      process.execPath,
      [path],
      expect.objectContaining({
        cwd: dirname(path),
        detached: true,
        stdio: "ignore",
        env: { HOME: "/home/user" },
      }),
    );
  });
});
