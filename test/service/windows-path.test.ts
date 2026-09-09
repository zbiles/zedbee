import { beforeEach, expect, it, vi } from "vitest";

// Replace only native calls; the real path-inspection/handle-lifetime code and
// Koffi's ABI helpers still execute. No test-only API is added to the product.
const native = vi.hoisted(() => ({
  access: [] as number[],
  closed: 0,
  attributes: 16,
  querySucceeds: true,
  openSucceeds: true,
  securityAttempted: false,
}));
vi.mock("koffi", async (original) => {
  const actual = (await original<typeof import("koffi")>()).default;
  const handle = Buffer.alloc(8);
  return {
    default: {
      ...actual,
      load: () => ({
        func: (...declaration: any[]) => {
          const name =
            declaration.length > 1
              ? declaration[1]
              : /\b(\w+)\s*\(/u.exec(declaration[0])?.[1];
          return (...args: any[]) => {
            if (name === "CreateFileW") {
              const [
                path,
                access,
                share,
                attributes,
                disposition,
                flags,
                template,
              ] = args;
              native.access.push(access);
              expect([share, attributes, disposition, flags, template]).toEqual(
                [3, null, 3, 0x02200000, null],
              );
              if (
                !native.openSucceeds ||
                (path === "ancestor" && access & 0x20000)
              )
                return null;
              return handle;
            }
            if (name === "GetFileInformationByHandleEx") {
              expect([args[0], args[1], args[3]]).toEqual([handle, 9, 8]);
              args[2].writeUInt32LE(native.attributes);
              return Number(native.querySucceeds);
            }
            if (name === "CloseHandle") {
              expect(args[0]).toBe(handle);
              native.closed++;
              return 1;
            }
            if (name === "GetLastError") return 5;
            if (name === "GetCurrentProcess") return handle;
            if (name === "OpenProcessToken") {
              native.securityAttempted = true;
              return 0; // An unavailable ownership proof must still reject private state.
            }
            throw new Error(`Unexpected native operation ${String(name)}`);
          };
        },
      }),
    },
  };
});
import { verifyWindowsPath } from "../../src/service/windows-pipe.js";

beforeEach(() => {
  native.access.length = 0;
  native.closed = 0;
  native.attributes = 16;
  native.querySucceeds = true;
  native.openSucceeds = true;
  native.securityAttempted = false;
});
it("inspects an ancestor whose attributes are readable but whose security descriptor is not", () => {
  expect(() => verifyWindowsPath("ancestor", false)).not.toThrow();
  expect(native.access).toEqual([0x80]);
  expect(native.closed).toBe(1);
  expect(native.securityAttempted).toBe(false);
});
it("still requests READ_CONTROL and requires ownership evidence for a private state path", () => {
  expect(() => verifyWindowsPath("private-state", true)).toThrow(
    "The private analyzer service is unavailable.",
  );
  expect(native.access).toEqual([0x20080]);
  expect(native.securityAttempted).toBe(true);
  expect(native.closed).toBe(1);
});
it.each(["reparse", "query", "open"])(
  "rejects ancestor %s failure without leaking an opened handle",
  (failure) => {
    if (failure === "reparse") native.attributes = 0x410;
    if (failure === "query") native.querySucceeds = false;
    if (failure === "open") native.openSucceeds = false;
    expect(() => verifyWindowsPath("ancestor", false)).toThrow(
      "The private analyzer service is unavailable.",
    );
    expect(native.closed).toBe(failure === "open" ? 0 : 1);
  },
);
