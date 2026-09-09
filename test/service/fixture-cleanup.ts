import { rm } from "node:fs/promises";
import { join } from "node:path";
import { ServiceState } from "../../src/service/state.js";
import type { ServiceStatus } from "../../src/service/server.js";

// Used only after every fixture-owned client has finished its cleanup proof.
export async function removeServiceFixture(
  root: string,
  status: ServiceStatus,
): Promise<void> {
  if (status.state === "unavailable") {
    // Deliberate service-death tests leave stale discovery. Unavailable is not
    // stopped: require independent ownership release before deleting fixture data.
    const lease = await new ServiceState(join(root, "s")).lease(
      undefined,
      false,
    );
    try {
      if (!lease.acquire())
        throw new Error("Fixture service still owns its startup lock");
    } finally {
      await lease.close();
    }
  } else if (status.state !== "stopped")
    throw new Error("Fixture service is still running");
  await rm(root, { recursive: true, force: true });
}
