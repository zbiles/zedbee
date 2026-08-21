import { describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";

const renderMock = vi.hoisted(() => vi.fn());

vi.mock("ink", () => ({ render: renderMock }));

import { renderStaticInk } from "../../src/ui/render-static.js";

function destination(
  callbackError: Error | null = null,
): NodeJS.WriteStream & { readonly writes: string[] } {
  const writes: string[] = [];
  return {
    rows: 31,
    writes,
    write(...args: unknown[]) {
      writes.push(String(args[0] ?? ""));
      const callback = args.find((argument) => typeof argument === "function");
      if (typeof callback === "function") {
        queueMicrotask(() =>
          (callback as (error: Error | null) => void)(callbackError),
        );
      }
      return true;
    },
  } as unknown as NodeJS.WriteStream & { readonly writes: string[] };
}

describe("renderStaticInk", () => {
  it("buffers a fixed-width non-TTY render and writes every chunk once", async () => {
    const stdout = destination();
    const unmount = vi.fn();
    const waitUntilExit = vi.fn(async () => undefined);
    renderMock.mockImplementationOnce(
      (_node: ReactNode, options: { stdout: NodeJS.WriteStream }) => {
        expect(options.stdout.isTTY).toBe(false);
        expect(options.stdout.columns).toBe(37);
        expect(options.stdout.rows).toBe(31);
        options.stdout.write("first chunk");
        options.stdout.write(Buffer.from(" + second chunk"));
        return {
          waitUntilRenderFlush: vi.fn(async () => undefined),
          unmount,
          waitUntilExit,
        };
      },
    );

    await renderStaticInk(null, { width: 37, stdout });

    expect(stdout.writes).toEqual(["first chunk + second chunk"]);
    expect(unmount).toHaveBeenCalledOnce();
    expect(waitUntilExit).toHaveBeenCalledOnce();
  });

  it("accepts a null write callback and releases resources before success", async () => {
    const stdout = destination(null);
    const unmount = vi.fn();
    renderMock.mockImplementationOnce(
      (_node: ReactNode, options: { stdout: NodeJS.WriteStream }) => {
        options.stdout.write("complete dashboard");
        return {
          waitUntilRenderFlush: vi.fn(async () => undefined),
          unmount,
          waitUntilExit: vi.fn(async () => undefined),
        };
      },
    );

    await expect(
      renderStaticInk(null, { width: 80, stdout }),
    ).resolves.toBeUndefined();
    expect(stdout.writes).toEqual(["complete dashboard"]);
    expect(unmount).toHaveBeenCalledOnce();
  });

  it("rejects destination failures after releasing render resources", async () => {
    const failure = new Error("destination failed");
    const stdout = destination(failure);
    const unmount = vi.fn();
    const waitUntilExit = vi.fn(async () => undefined);
    renderMock.mockImplementationOnce(
      (_node: ReactNode, options: { stdout: NodeJS.WriteStream }) => {
        options.stdout.write("complete dashboard");
        return {
          waitUntilRenderFlush: vi.fn(async () => undefined),
          unmount,
          waitUntilExit,
        };
      },
    );

    await expect(renderStaticInk(null, { width: 80, stdout })).rejects.toThrow(
      "destination failed",
    );
    expect(unmount).toHaveBeenCalledOnce();
    expect(waitUntilExit).toHaveBeenCalledOnce();
  });

  it("releases render resources when the render flush fails", async () => {
    const failure = new Error("render failed");
    const stdout = destination();
    const unmount = vi.fn();
    const waitUntilExit = vi.fn(async () => undefined);
    renderMock.mockReturnValueOnce({
      waitUntilRenderFlush: vi.fn(async () => {
        throw failure;
      }),
      unmount,
      waitUntilExit,
    });

    await expect(renderStaticInk(null, { width: 80, stdout })).rejects.toThrow(
      "render failed",
    );
    expect(stdout.writes).toEqual([]);
    expect(unmount).toHaveBeenCalledOnce();
    expect(waitUntilExit).toHaveBeenCalledOnce();
  });
});
