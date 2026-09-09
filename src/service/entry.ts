import { exactFields } from "../checks/runner/envelope.js";
import { serviceIdentity } from "./identity.js";
import { ServiceState } from "./state.js";
import { HEX } from "./protocol.js";
import { startServiceServer } from "./server.js";

// This installed entry accepts only a private, source-free parent IPC startup.
// The caller may detach only after the kernel lock and restricted endpoint exist.
if (!process.connected) process.exit(1);
// Hash only this fixed installation while the parent independently hashes it.
// Observe failure immediately, and retain ownership even before startup IPC.
const pendingIdentity = serviceIdentity();
void pendingIdentity.catch(() => {});
let starting = false,
  detached = false,
  abandoned = false;
let server: Awaited<ReturnType<typeof startServiceServer>> | undefined;
let release: (() => Promise<void>) | undefined;
let startup: Promise<void> | undefined;
let finishing: Promise<void> | undefined;
let endpointStarted = false;
const finish = () => {
  abandoned = true;
  return (finishing ??= (async () => {
    // Endpoint construction may already own asynchronous native resources even
    // before it returns a server. Keep the same kernel lock until it settles
    // and its resulting endpoint has completed cleanup.
    await startup?.catch(() => {});
    await pendingIdentity.catch(() => {});
    // Rejection alone is not endpoint-cleanup evidence. If construction never
    // returned its cleanup owner, retain this handle until process death; do
    // not let another candidate race an endpoint whose cleanup is unproved.
    if (endpointStarted && !server) return;
    await server?.close();
    await release?.();
    release = undefined;
  })());
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
  startup = (async () => {
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
    const identity = await pendingIdentity;
    if (identity.content !== value.identity || abandoned) throw new Error();
    endpointStarted = true;
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
      if (error)
        void finish().catch(() => {
          process.exitCode = 1;
        });
    });
  })();
  // This reaction is outside startup, so finish can await startup settlement
  // without waiting on its own error-handler promise.
  void startup.catch(async () => {
    await finish().catch(() => {});
    if (process.connected)
      process.send?.({ type: "unavailable" }, () => process.disconnect?.());
    process.exitCode = 1;
  });
});
