import { OsvAnalysisError } from "./errors.js";

export const MAX_OSV_RESPONSE_BYTES = 4 * 1024 * 1024;

export async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType === undefined || !contentType.split(";", 1)[0]?.trim().endsWith("/json")) {
    throw new OsvAnalysisError(
      "OSV_RESPONSE_INVALID",
      "OSV returned a response with an unsupported content type.",
    );
  }
  const declaredLength = response.headers.get("content-length");
  if (
    declaredLength !== null &&
    (!/^\d+$/u.test(declaredLength) || Number(declaredLength) > MAX_OSV_RESPONSE_BYTES)
  ) {
    throw new OsvAnalysisError(
      "OSV_RESPONSE_TOO_LARGE",
      "OSV returned a response larger than Zedbee's safety limit.",
    );
  }
  if (response.body === null) {
    throw new OsvAnalysisError(
      "OSV_RESPONSE_INVALID",
      "OSV returned an empty response body.",
    );
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_OSV_RESPONSE_BYTES) {
        throw new OsvAnalysisError(
          "OSV_RESPONSE_TOO_LARGE",
          "OSV returned a response larger than Zedbee's safety limit.",
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    text = "";
    throw new OsvAnalysisError(
      "OSV_RESPONSE_INVALID",
      "OSV returned invalid JSON data.",
    );
  }
}
