import { readBoundedBody } from "../../../core/read-bounded-body.js";
import { OsvAnalysisError } from "./errors.js";

export const MAX_OSV_RESPONSE_BYTES = 4 * 1024 * 1024;

function responseTooLarge(): OsvAnalysisError {
  return new OsvAnalysisError(
    "OSV_RESPONSE_TOO_LARGE",
    "OSV returned a response larger than Zedbee's safety limit.",
  );
}

export async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // The body was already closed or errored; nothing left to release.
  }
}

export async function readJsonResponse(response: Response): Promise<unknown> {
  const contentType = response.headers.get("content-type")?.toLowerCase();
  if (contentType === undefined || !contentType.split(";", 1)[0]?.trim().endsWith("/json")) {
    await discardResponseBody(response);
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
    await discardResponseBody(response);
    throw responseTooLarge();
  }
  if (response.body === null) {
    throw new OsvAnalysisError(
      "OSV_RESPONSE_INVALID",
      "OSV returned an empty response body.",
    );
  }
  const bytes = await readBoundedBody(response.body, MAX_OSV_RESPONSE_BYTES);
  if (bytes === undefined) throw responseTooLarge();
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    ) as unknown;
  } catch {
    throw new OsvAnalysisError(
      "OSV_RESPONSE_INVALID",
      "OSV returned invalid JSON data.",
    );
  }
}
