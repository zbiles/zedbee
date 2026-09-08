import koffi from "koffi";
import { ServiceUnavailableError } from "./protocol.js";

// Loaded only on Windows. All handles are noninherited and every descriptor is freed.
const kernel = koffi.load("kernel32.dll"),
  security = koffi.load("advapi32.dll");
const ptr = koffi.out(koffi.pointer("void *"));
const uint = koffi.out(koffi.pointer("uint32"));
const integer = koffi.out(koffi.pointer("int"));
const close = kernel.func("int __stdcall CloseHandle(void *)");
const free = kernel.func("void * __stdcall LocalFree(void *)");
const errorCode = kernel.func("uint32 __stdcall GetLastError()");
const open = kernel.func(
  "void * __stdcall CreateFileW(const char16_t *, uint32, uint32, void *, uint32, uint32, void *)",
);
const createDirectory = kernel.func(
  "int __stdcall CreateDirectoryW(const char16_t *, void *)",
);
const currentProcess = kernel.func("void * __stdcall GetCurrentProcess()");
const openToken = security.func("__stdcall", "OpenProcessToken", "int", [
  "void *",
  "uint32",
  ptr,
]);
const getToken = security.func("__stdcall", "GetTokenInformation", "int", [
  "void *",
  "int",
  "void *",
  "uint32",
  uint,
]);
const sidString = security.func("__stdcall", "ConvertSidToStringSidW", "int", [
  "void *",
  ptr,
]);
const convert = security.func(
  "__stdcall",
  "ConvertStringSecurityDescriptorToSecurityDescriptorW",
  "int",
  ["str16", "uint32", ptr, "void *"],
);
const getDacl = security.func("__stdcall", "GetSecurityDescriptorDacl", "int", [
  "void *",
  integer,
  ptr,
  integer,
]);
const getSecurity = security.func("__stdcall", "GetSecurityInfo", "uint32", [
  "void *",
  "int",
  "uint32",
  ptr,
  "void *",
  ptr,
  "void *",
  ptr,
]);
const setSecurity = security.func(
  "uint32 __stdcall SetSecurityInfo(void *, int, uint32, void *, void *, void *, void *)",
);
const getControl = security.func(
  "__stdcall",
  "GetSecurityDescriptorControl",
  "int",
  ["void *", koffi.out(koffi.pointer("uint16")), uint],
);
const equalSid = security.func("int __stdcall EqualSid(void *, void *)");
const getAce = security.func("__stdcall", "GetAce", "int", [
  "void *",
  "uint32",
  ptr,
]);
const fileInfo = kernel.func(
  "int __stdcall GetFileInformationByHandleEx(void *, int, void *, uint32)",
);
const lockFile = kernel.func(
  "int __stdcall LockFileEx(void *, uint32, uint32, uint32, uint32, void *)",
);
const attributes = koffi.struct({
  length: "uint32",
  descriptor: "void *",
  inherit: "int",
});
const overlapped = koffi.struct({
  internal: "uintptr_t",
  internalHigh: "uintptr_t",
  offset: "uint32",
  offsetHigh: "uint32",
  event: "void *",
});

function fail(): never {
  const code = errorCode();
  if (code === 2 || code === 3)
    throw Object.assign(new ServiceUnavailableError(), { code: "ENOENT" });
  throw new ServiceUnavailableError();
}
function validHandle(handle: unknown): boolean {
  return (
    !!handle &&
    koffi.address(handle) !== (1n << BigInt(koffi.sizeof("void *") * 8)) - 1n
  );
}
function checkedClose(handle: unknown): void {
  if (!close(handle)) throw new ServiceUnavailableError();
}
function withIdentity<T>(run: (sid: unknown, text: string) => T): T {
  const token = [null];
  if (!openToken(currentProcess(), 8, token)) fail();
  try {
    const length = [0];
    getToken(token[0], 1, null, 0, length);
    if (errorCode() !== 122 || !length[0] || length[0] > 65536) fail();
    const bytes = Buffer.alloc(length[0]);
    if (!getToken(token[0], 1, bytes, bytes.length, length)) fail();
    const sid = koffi.decode(bytes, "void *");
    const text = [null];
    if (!sidString(sid, text)) fail();
    try {
      return run(sid, koffi.decode(text[0], "char16_t", -1) as string);
    } finally {
      free(text[0]);
    }
  } finally {
    checkedClose(token[0]);
  }
}
function withDescriptor<T>(
  run: (descriptor: unknown, acl: unknown) => T,
  job = false,
): T {
  return withIdentity((_sid, text) => {
    const descriptor = [null];
    if (
      !convert(
        `O:${text}D:P(A;${job ? "" : "OICI"};${job ? "GA" : "FA"};;;${text})`,
        1,
        descriptor,
        null,
      )
    )
      fail();
    try {
      const present = [0],
        acl = [null],
        defaulted = [0];
      if (
        !getDacl(descriptor[0], present, acl, defaulted) ||
        !present[0] ||
        !acl[0]
      )
        fail();
      return run(descriptor[0], acl[0]);
    } finally {
      free(descriptor[0]);
    }
  });
}
function verify(handle: unknown, kind: number): void {
  withIdentity((sid) => {
    const descriptor = [null],
      owner = [null],
      acl = [null];
    if (
      getSecurity(handle, kind, 1 | 4, owner, null, acl, null, descriptor) !== 0
    )
      throw new ServiceUnavailableError();
    try {
      const control = [0],
        revision = [0];
      if (
        !owner[0] ||
        !acl[0] ||
        !equalSid(owner[0], sid) ||
        !getControl(descriptor[0], control, revision) ||
        !(control[0]! & 0x1000)
      )
        throw new ServiceUnavailableError();
      const header = Buffer.from(koffi.decode(acl[0], "uint8", 8) as number[]);
      if (header.readUInt16LE(4) !== 1) throw new ServiceUnavailableError();
      const ace = [null];
      if (!getAce(acl[0], 0, ace)) fail();
      const entry = Buffer.from(koffi.decode(ace[0], "uint8", 8) as number[]);
      const size = entry.readUInt16LE(2),
        mask = entry.readUInt32LE(4);
      if (
        entry[0] !== 0 ||
        (entry[1]! & ~3) !== 0 ||
        size < 16 ||
        size > 1024 ||
        (mask !== 0x001f01ff && mask !== 0x10000000 && mask !== 0x001f001f && mask !== 0x001f003f)
      )
        throw new ServiceUnavailableError();
      const aceBytes = Buffer.from(
        koffi.decode(ace[0], "uint8", size) as number[],
      );
      if (!equalSid(aceBytes.subarray(8), sid))
        throw new ServiceUnavailableError();
    } finally {
      free(descriptor[0]);
    }
  });
}
function pathHandle(path: string, access = 0x20000 | 0x80): unknown {
  // OPEN_REPARSE_POINT inspects the lexical entry; BACKUP_SEMANTICS permits dirs.
  const handle = open(
    path,
    access,
    1 | 2,
    null,
    3,
    0x00200000 | 0x02000000,
    null,
  );
  if (!validHandle(handle)) fail();
  try {
    const info = Buffer.alloc(8);
    if (!fileInfo(handle, 9, info, info.length) || info.readUInt32LE() & 0x400)
      throw new ServiceUnavailableError();
    return handle;
  } catch (error) {
    checkedClose(handle);
    throw error;
  }
}
export function verifyWindowsPath(path: string, ownerOnly: boolean): void {
  const handle = pathHandle(path);
  try {
    if (ownerOnly) verify(handle, 1);
  } finally {
    checkedClose(handle);
  }
}
export function createWindowsDirectory(path: string): void {
  withDescriptor((descriptor) => {
    const bytes = Buffer.alloc(koffi.sizeof(attributes));
    koffi.encode(bytes, attributes, {
      length: bytes.length,
      descriptor,
      inherit: 0,
    });
    if (!createDirectory(path, bytes) && errorCode() !== 183) fail();
  });
  verifyWindowsPath(path, true);
}
export function restrictWindowsPath(path: string): void {
  const handle = pathHandle(path, 0x20000 | 0x40000 | 0x80);
  try {
    withDescriptor((_descriptor, acl) => {
      if (setSecurity(handle, 1, 4 | 0x80000000, null, null, acl, null) !== 0)
        throw new ServiceUnavailableError();
    });
    verify(handle, 1);
  } finally {
    checkedClose(handle);
  }
}
export function openWindowsStateLease(
  path: string,
  create = true,
): { acquire(): boolean; close(): void } {
  let handle: unknown;
  withDescriptor((descriptor) => {
    const bytes = Buffer.alloc(koffi.sizeof(attributes));
    koffi.encode(bytes, attributes, {
      length: bytes.length,
      descriptor,
      inherit: 0,
    });
    handle = open(
      path,
      0x80000000 | 0x40000000 | 0x20000,
      1 | 2,
      bytes,
      create ? 4 : 3,
      0x00200000,
      null,
    );
  });
  if (!validHandle(handle)) fail();
  try {
    const info = Buffer.alloc(8);
    if (!fileInfo(handle, 9, info, info.length) || info.readUInt32LE() & 0x400)
      throw new ServiceUnavailableError();
    const standard = Buffer.alloc(24);
    if (
      !fileInfo(handle, 1, standard, standard.length) ||
      standard.readBigInt64LE(8) !== 0n ||
      standard.readUInt32LE(16) !== 1 ||
      standard[20] !== 0 ||
      standard[21] !== 0
    )
      throw new ServiceUnavailableError();
    verify(handle, 1);
    const overlap = Buffer.alloc(koffi.sizeof(overlapped));
    let closed = false,
      acquired = false;
    return {
      acquire() {
        if (closed) throw new ServiceUnavailableError();
        if (acquired) return true;
        if (lockFile(handle, 1 | 2, 0, 1, 0, overlap)) {
          acquired = true;
          return true;
        }
        if (errorCode() === 33) return false;
        throw new ServiceUnavailableError();
      },
      close() {
        if (!closed) {
          checkedClose(handle);
          closed = true;
        }
      },
    };
  } catch (error) {
    if (handle) checkedClose(handle);
    throw error;
  }
}
/** No Node private handle fields: open only the controlled local pipe endpoint. */
export function restrictWindowsPipe(endpoint: string): void {
  if (!/^\\\\\.\\pipe\\zedbee-[a-f0-9]{64}$/u.test(endpoint))
    throw new ServiceUnavailableError();
  const handle = open(endpoint, 0x20000 | 0x40000, 0, null, 3, 0, null);
  if (!validHandle(handle)) fail();
  try {
    withDescriptor((_descriptor, acl) => {
      if (setSecurity(handle, 6, 4 | 0x80000000, null, null, acl, null) !== 0)
        throw new ServiceUnavailableError();
    });
    verify(handle, 6);
  } finally {
    checkedClose(handle);
  }
}
const createJob = kernel.func(
  "void * __stdcall CreateJobObjectW(void *, const char16_t *)",
);
const openJob = kernel.func(
  "void * __stdcall OpenJobObjectW(uint32, int, const char16_t *)",
);
const terminateJob = kernel.func(
  "int __stdcall TerminateJobObject(void *, uint32)",
);
const accounting = koffi.struct({
  totalUser: "int64",
  totalKernel: "int64",
  periodUser: "int64",
  periodKernel: "int64",
  pageFaults: "uint32",
  totalProcesses: "uint32",
  activeProcesses: "uint32",
  terminated: "uint32",
});
const queryJob = kernel.func(
  "int __stdcall QueryInformationJobObject(void *, int, void *, uint32, void *)",
);
function jobName(name: string): void {
  if (!/^Local\\zedbee-[a-f0-9]{64}$/u.test(name))
    throw new ServiceUnavailableError();
}
export function createOwnedWindowsJobHandle(name: string): unknown {
  jobName(name);
  return withDescriptor((descriptor) => {
    const bytes = Buffer.alloc(koffi.sizeof(attributes));
    koffi.encode(bytes, attributes, {
      length: bytes.length,
      descriptor,
      inherit: 0,
    });
    const handle = createJob(bytes, name);
    if (!handle) fail();
    try {
      if (errorCode() === 183) throw new ServiceUnavailableError();
      verify(handle, 6);
      return handle;
    } catch (error) {
      checkedClose(handle);
      throw error;
    }
  }, true);
}
export function openWindowsJobWitness(name: string): {
  close(): void;
  stop(): Promise<void>;
} {
  jobName(name);
  const handle = openJob(0x20000 | 4 | 8, 0, name);
  if (!handle) fail();
  try {
    verify(handle, 6);
  } catch (error) {
    checkedClose(handle);
    throw error;
  }
  let closed = false;
  const finish = () => {
    if (!closed) {
      checkedClose(handle);
      closed = true;
    }
  };
  return {
    close: finish,
    async stop() {
      if (closed) return;
      if (!terminateJob(handle, 0x5a454442))
        throw new ServiceUnavailableError();
      const state = Buffer.alloc(koffi.sizeof(accounting));
      while (true) {
        if (!queryJob(handle, 1, state, state.length, null))
          throw new ServiceUnavailableError();
        if (
          state.readUInt32LE(koffi.offsetof(accounting, "activeProcesses")) ===
          0
        )
          break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      finish();
    },
  };
}
