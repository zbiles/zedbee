import { exactFields } from "../checks/runner/envelope.js";
import { serviceIdentity } from "./identity.js";
import { ServiceState } from "./state.js";
import { HEX } from "./protocol.js";
import { startServiceServer } from "./server.js";

// This installed entry accepts only a private, source-free parent IPC startup.
// The caller may detach only after the kernel lock and restricted endpoint exist.
if (!process.connected) process.exit(1);
let starting = false,
  detached = false,
  abandoned = false;
let server: Awaited<ReturnType<typeof startServiceServer>> | undefined;
let release: (() => Promise<void>) | undefined;
const finish = async () => {
  abandoned = true;
  await server?.close();
  await release?.();
};
process.on("disconnect", () => {
  if (!detached)
    void finish().catch(() => {
      process.exitCode = 1;
    });
});
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"] as const)
  process.on(signal, () => {
    void finish().catch(() => {
      process.exitCode = 1;
    });
  });
process.on("message", (value: unknown) => {
  if (starting) {
    if (server && exactFields(value, ["type"]) && value.type === "detach") {
      detached = true;
      if (process.connected) process.disconnect?.();
    }
    return;
  }
  starting = true;
  void (async () => {
    if (
      !exactFields(value, ["directory", "identity", "concurrency"]) ||
      typeof value.directory !== "string" ||
      typeof value.identity !== "string" ||
      !HEX.test(value.identity) ||
      ![1, 2, 4].includes(value.concurrency as number)
    )
      throw new Error();
    const state = new ServiceState(value.directory);
    await state.prepare();
    release = await state.lock();
    if (!release) {
      process.send?.({ type: "busy" }, () => process.disconnect?.());
      return;
    }
    if (abandoned) {
      await release();
      return;
    }
    const identity = await serviceIdentity(value.directory);
    if (identity.content !== value.identity || abandoned) throw new Error();
    server = await startServiceServer(
      state,
      identity.content,
      value.concurrency as 1 | 2 | 4,
      release,
    );
    release = undefined;
    if (abandoned) {
      await server.close();
      return;
    }
    process.send?.({ type: "ready" }, (error) => {
      if (error) void finish();
    });
  })().catch(async () => {
    await finish().catch(() => {});
    if (process.connected)
      process.send?.({ type: "unavailable" }, () => process.disconnect?.());
    process.exitCode = 1;
  });
});
