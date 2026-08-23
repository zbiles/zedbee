import { describe, expect, it, vi } from "vitest";
import {
  disableTerminalMouse,
  enableTerminalMouse,
  terminalMouseSequences,
} from "../../src/ui/terminal-mouse.js";

describe("terminal mouse lifecycle", () => {
  it("enables basic and SGR mouse reporting and returns idempotent cleanup", () => {
    const write = vi.fn();
    const cleanup = enableTerminalMouse({ write });
    expect(write).toHaveBeenCalledWith(terminalMouseSequences.enable);
    cleanup();
    cleanup();
    expect(write).toHaveBeenLastCalledWith(terminalMouseSequences.disable);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("can defensively disable reporting without prior local state", () => {
    const write = vi.fn();
    disableTerminalMouse({ write });
    expect(write).toHaveBeenCalledWith(terminalMouseSequences.disable);
  });
});
