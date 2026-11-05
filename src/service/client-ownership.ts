import { exactFields } from "../checks/runner/envelope.js";
import { HEX, ServiceUnavailableError } from "./protocol.js";
import type { ServiceState, StateLease } from "./state.js";
import { stopProcessGroup } from "../checks/runner/process-group.js";

/** Independent OS witnesses, never socket closure, authorize source cleanup. */
export class ClientOwnership {
  private readonly events = new Set<Promise<void>>();
  private readonly leases = new Map<string, StateLease>();
  private readonly trees = new Map<
    string,
    { sessionId: string; stop(): Promise<void>; close(): void }
  >();
  constructor(
    private readonly state: Pick<ServiceState, "lease" | "removeLease">,
    private readonly acknowledge: (eventId: string) => Promise<unknown>,
    private readonly connected: () => boolean,
  ) {}
  private async releaseLease(id: string): Promise<void> {
    const lease = this.leases.get(id);
    if (!lease) throw new ServiceUnavailableError();
    while (!lease.acquire())
      await new Promise((resolve) => setTimeout(resolve, 20));
    await lease.close();
    this.leases.delete(id);
    await this.state.removeLease(id);
  }
  async close(): Promise<void> {
    await Promise.allSettled([...this.events]);
    await Promise.all([...this.trees.values()].map((tree) => tree.stop()));
    this.trees.clear();
    await Promise.all(
      [...this.leases.keys()].map((id) => this.releaseLease(id)),
    );
  }
  accept(value: Record<string, unknown>): Promise<void> {
    const operation = this.acceptEvent(value);
    this.events.add(operation);
    void operation.then(
      () => this.events.delete(operation),
      () => this.events.delete(operation),
    );
    return operation;
  }
  private async acceptEvent(value: Record<string, unknown>): Promise<void> {
    if (
      typeof value.eventId !== "string" ||
      !HEX.test(value.eventId) ||
      typeof value.sessionId !== "string" ||
      !HEX.test(value.sessionId)
    )
      throw new ServiceUnavailableError();
    const id = value.sessionId;
    if (
      value.type === "io-acquire" &&
      exactFields(value, ["type", "eventId", "sessionId"])
    ) {
      if (this.leases.size >= 4 || this.leases.has(id))
        throw new ServiceUnavailableError();
      const lease = await this.state.lease(id, false);
      this.leases.set(id, lease);
    } else if (
      value.type === "io-release" &&
      exactFields(value, ["type", "eventId", "sessionId"])
    ) {
      await this.releaseLease(id);
    } else if (
      value.type === "tree-acquire" &&
      exactFields(value, ["type", "eventId", "sessionId", "witness"])
    ) {
      const witness = value.witness;
      if (
        !this.leases.has(id) ||
        this.trees.size >= 4 ||
        !exactFields(witness, ["id", "kind", "pgid", "jobName"]) ||
        typeof witness.id !== "string" ||
        !HEX.test(witness.id) ||
        this.trees.has(witness.id)
      )
        throw new ServiceUnavailableError();
      if (
        witness.kind === "windows" &&
        process.platform === "win32" &&
        exactFields(witness, ["id", "kind", "jobName"]) &&
        witness.jobName === `Local\\zedbee-${witness.id}`
      ) {
        const owned = (await import("./windows-pipe.js")).openWindowsJobWitness(
          witness.jobName as string,
        );
        this.trees.set(witness.id, { sessionId: id, ...owned });
      } else if (
        witness.kind === "posix" &&
        process.platform !== "win32" &&
        exactFields(witness, ["id", "kind", "pgid"]) &&
        Number.isSafeInteger(witness.pgid) &&
        (witness.pgid as number) > 0
      ) {
        const pgid = witness.pgid as number;
        this.trees.set(witness.id, {
          sessionId: id,
          stop: () => stopProcessGroup(pgid),
          close() {},
        });
      } else throw new ServiceUnavailableError();
    } else if (
      value.type === "tree-release" &&
      exactFields(value, ["type", "eventId", "sessionId", "witnessId"]) &&
      typeof value.witnessId === "string"
    ) {
      const owned = this.trees.get(value.witnessId);
      if (!owned || owned.sessionId !== id) throw new ServiceUnavailableError();
      owned.close();
      this.trees.delete(value.witnessId);
    } else throw new ServiceUnavailableError();
    if (this.connected()) await this.acknowledge(value.eventId);
  }
}
