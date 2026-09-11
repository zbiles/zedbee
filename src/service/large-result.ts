import {
  exactFields,
  AnalyzerCapacityError,
} from "../checks/runner/envelope.js";
import { ByteBudget, decodeJson, ServiceUnavailableError } from "./protocol.js";

// Frame sizes stay unchanged. Larger replies have a separate, bounded lifetime.
export const MAX_RESULT_BYTES = 128 * 1024 * 1024;
export const RETAINED_RESULT_BYTES = 256 * 1024 * 1024;
export const RESULT_CHUNK_BYTES = 256 * 1024;

export class ResultAssembler {
  private body: Buffer | undefined;
  private offset = 0;
  private release: (() => void) | undefined;
  constructor(private readonly budget: ByteBudget) {}

  accept(
    value: unknown,
    receive: (value: unknown, release: () => void) => void,
  ): boolean {
    if (
      !exactFields(value, ["type", "bytes", "data"]) ||
      typeof value.type !== "string" ||
      !value.type.startsWith("result-")
    )
      return false;
    if (
      value.type === "result-start" &&
      exactFields(value, ["type", "bytes"])
    ) {
      if (
        this.body ||
        !Number.isSafeInteger(value.bytes) ||
        (value.bytes as number) <= 0
      )
        throw new ServiceUnavailableError();
      if ((value.bytes as number) > MAX_RESULT_BYTES)
        throw new AnalyzerCapacityError("request");
      this.release = this.budget.reserve(value.bytes as number);
      this.body = Buffer.allocUnsafe(value.bytes as number);
      this.offset = 0;
    } else if (
      value.type === "result-chunk" &&
      exactFields(value, ["type", "data"])
    ) {
      if (
        !this.body ||
        typeof value.data !== "string" ||
        !value.data.length ||
        value.data.length > Math.ceil(RESULT_CHUNK_BYTES / 3) * 4
      )
        throw new ServiceUnavailableError();
      const chunk = Buffer.from(value.data, "base64");
      if (
        !chunk.length ||
        chunk.length > RESULT_CHUNK_BYTES ||
        chunk.toString("base64") !== value.data ||
        this.offset + chunk.length > this.body.length
      )
        throw new ServiceUnavailableError();
      chunk.copy(this.body, this.offset);
      this.offset += chunk.length;
    } else if (value.type === "result-end" && exactFields(value, ["type"])) {
      if (!this.body || this.offset !== this.body.length)
        throw new ServiceUnavailableError();
      const body = this.body,
        release = this.release!;
      this.body = undefined;
      this.release = undefined;
      this.offset = 0;
      try {
        receive(decodeJson(body), release);
      } catch (error) {
        release();
        throw error;
      }
    } else throw new ServiceUnavailableError();
    return true;
  }

  close(): void {
    this.release?.();
    this.release = undefined;
    this.body = undefined;
    this.offset = 0;
  }
}
