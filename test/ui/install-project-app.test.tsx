import { render } from "ink-testing-library";
import { describe, expect, it, vi } from "vitest";
import { waitForAssertion } from "../helpers/wait-for-assertion.js";
import { InstallProjectApp } from "../../src/ui/install-project-app.js";

const targets = [
  {
    projectRoot: "e2e",
    manager: "npm" as const,
    args: ["install", "--save-dev", "zedbee@0.1.0-beta.5"],
    hasPrettier: false,
  },
  {
    projectRoot: "web",
    manager: "npm" as const,
    args: ["install", "--save-dev", "zedbee@0.1.0-beta.5"],
    hasPrettier: true,
  },
];

describe("interactive project installation", () => {
  it("aborts an active installation before leaving the shell", async () => {
    let installedSignal: AbortSignal | undefined;
    const install = vi.fn(
      (_target, signal: AbortSignal) =>
        new Promise<void>((_resolve, reject) => {
          installedSignal = signal;
          signal.addEventListener(
            "abort",
            () => reject(new Error("Canceled")),
            { once: true },
          );
        }),
    );
    const decision = vi.fn();
    const view = render(
      <InstallProjectApp
        targets={targets}
        width={100}
        color={false}
        install={install}
        onDecision={decision}
      />,
    );
    await waitForAssertion(() =>
      expect(view.lastFrame()).toContain("Enter Continue"),
    );
    view.stdin.write("\r");
    await waitForAssertion(() =>
      expect(view.lastFrame()).toContain("Preparing"),
    );
    view.stdin.write("\u001b");
    await waitForAssertion(() => expect(decision).toHaveBeenCalledWith(false));
    expect(installedSignal?.aborted).toBe(true);
    view.unmount();
  });
  it("selects a folder, installs it, and continues", async () => {
    const install = vi.fn(async () => {});
    const decision = vi.fn();
    const view = render(
      <InstallProjectApp
        targets={targets}
        width={100}
        color={false}
        install={install}
        onDecision={decision}
      />,
    );
    await waitForAssertion(() =>
      expect(view.lastFrame()).toContain("PROJECT FOLDER"),
    );
    expect(view.lastFrame()).toContain("Prettier detected");
    expect(view.lastFrame()).not.toContain("npm install");
    view.stdin.write("\u001b[B");
    await new Promise((resolve) => setTimeout(resolve, 50));
    view.stdin.write("\r");
    await waitForAssertion(() => expect(decision).toHaveBeenCalledWith(true));
    expect(install).toHaveBeenCalledWith(targets[1], expect.any(AbortSignal));
    view.unmount();
  });
  it("cancels before installation without calling the installer", async () => {
    const install = vi.fn(async () => {});
    const decision = vi.fn();
    const view = render(
      <InstallProjectApp
        targets={targets}
        width={100}
        color={false}
        install={install}
        onDecision={decision}
      />,
    );
    await waitForAssertion(() =>
      expect(view.lastFrame()).toContain("PROJECT FOLDER"),
    );
    view.stdin.write("\u001b");
    await waitForAssertion(() => expect(decision).toHaveBeenCalledWith(false));
    expect(install).not.toHaveBeenCalled();
    view.unmount();
  });
  it("keeps installation errors in the interactive shell for retry", async () => {
    const install = vi
      .fn()
      .mockRejectedValueOnce(new Error("Registry unavailable"))
      .mockResolvedValueOnce(undefined);
    const decision = vi.fn();
    const view = render(
      <InstallProjectApp
        targets={targets}
        width={100}
        color={false}
        install={install}
        onDecision={decision}
      />,
    );
    await waitForAssertion(() =>
      expect(view.lastFrame()).toContain("PROJECT FOLDER"),
    );
    view.stdin.write("\r");
    await waitForAssertion(() =>
      expect(view.lastFrame()).toContain("Registry unavailable"),
    );
    expect(decision).not.toHaveBeenCalled();
    view.stdin.write("\r");
    await waitForAssertion(() => expect(decision).toHaveBeenCalledWith(true));
    view.unmount();
  });
});
