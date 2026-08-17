import { describe, expect, it } from "vitest";
import {
  createOsvClient,
  osvQueryKey,
} from "../../../../src/checks/vulnerabilities/osv/client.js";
import {
  OsvAnalysisError,
  OsvUnavailableError,
} from "../../../../src/checks/vulnerabilities/osv/errors.js";

interface RequestRecord {
  readonly url: string;
  readonly init: RequestInit;
  readonly body?: unknown;
}

function json(
  value: unknown,
  status = 200,
  headers: Readonly<Record<string, string>> = {},
): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function requestRecorder(
  handler: (request: RequestRecord) => Promise<Response> | Response,
): { readonly requests: RequestRecord[]; readonly fetch: typeof fetch } {
  const requests: RequestRecord[] = [];
  const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = input instanceof Request ? input.url : String(input);
    const body =
      typeof init.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const request = { url, init, ...(body === undefined ? {} : { body }) };
    requests.push(request);
    return handler(request);
  }) as typeof globalThis.fetch;
  return { requests, fetch };
}

const alpha = { name: "alpha", version: "1.0.0", ecosystem: "npm" as const };
const beta = { name: "beta", version: "2.0.0", ecosystem: "npm" as const };

describe("OsvClient", () => {
  it("deduplicates stable queries, follows per-result pagination, and bounds detail concurrency", async () => {
    let detailActive = 0;
    let maximumDetailActive = 0;
    const recorder = requestRecorder(async ({ url, body }) => {
      if (url.endsWith("/v1/querybatch")) {
        const queries = (body as { queries: Array<{ page_token?: string }> }).queries;
        if (queries[0]?.page_token === "page-2") {
          return json({ results: [{ vulns: [{ id: "OSV-C" }] }] });
        }
        return json({
          results: [
            { vulns: [{ id: "OSV-A" }], next_page_token: "page-2" },
            { vulns: [{ id: "OSV-A" }, { id: "OSV-B" }] },
          ],
        });
      }
      detailActive += 1;
      maximumDetailActive = Math.max(maximumDetailActive, detailActive);
      await Promise.resolve();
      detailActive -= 1;
      return json({ id: decodeURIComponent(url.split("/").at(-1) ?? ""), affected: [] });
    });
    const client = createOsvClient({
      fetch: recorder.fetch,
      detailConcurrency: 2,
      retries: 0,
    });

    const result = await client.query(
      [alpha, beta, { ...alpha }],
      new AbortController().signal,
    );

    expect([...result.keys()]).toEqual([osvQueryKey(alpha), osvQueryKey(beta)]);
    expect(result.get(osvQueryKey(alpha))?.map(({ id }) => id)).toEqual([
      "OSV-A",
      "OSV-C",
    ]);
    expect(result.get(osvQueryKey(beta))?.map(({ id }) => id)).toEqual([
      "OSV-A",
      "OSV-B",
    ]);
    expect(maximumDetailActive).toBeLessThanOrEqual(2);
    expect(recorder.requests.filter(({ url }) => url.endsWith("/v1/querybatch"))).toHaveLength(2);
  });

  it.each([429, 500, 503])("classifies HTTP %i as temporary unavailability", async (status) => {
    const recorder = requestRecorder(() => json({}, status));
    const client = createOsvClient({ fetch: recorder.fetch, retries: 0 });
    await expect(client.query([alpha], new AbortController().signal)).rejects.toBeInstanceOf(
      OsvUnavailableError,
    );
  });

  it.each([400, 401, 404])("classifies HTTP %i as an analysis failure", async (status) => {
    const recorder = requestRecorder(() => json({}, status));
    const client = createOsvClient({ fetch: recorder.fetch, retries: 0 });
    await expect(client.query([alpha], new AbortController().signal)).rejects.toBeInstanceOf(
      OsvAnalysisError,
    );
  });

  it("rejects redirects, wrong content types, oversized bodies, invalid JSON, and invalid schemas", async () => {
    const responses = [
      new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
      new Response("{}", { headers: { "content-type": "text/plain" } }),
      json({}, 200, { "content-length": "99999999" }),
      new Response("{", { headers: { "content-type": "application/json" } }),
      json({ results: "not-an-array" }),
    ];
    for (const response of responses) {
      const recorder = requestRecorder(() => response);
      const client = createOsvClient({ fetch: recorder.fetch, retries: 0 });
      await expect(client.query([alpha], new AbortController().signal)).rejects.toBeInstanceOf(
        OsvAnalysisError,
      );
    }
  });

  it("classifies network errors and timeouts without retaining raw causes", async () => {
    const network = requestRecorder(() => {
      throw new TypeError("dns leaked-host.internal private-token");
    });
    await expect(
      createOsvClient({ fetch: network.fetch, retries: 0 }).query(
        [alpha],
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ name: "OsvUnavailableError", code: "OSV_NETWORK_UNAVAILABLE" });

    const hanging = requestRecorder(
      ({ init }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new DOMException("raw timeout", "AbortError")));
        }),
    );
    const timeoutClient = createOsvClient({ fetch: hanging.fetch, timeoutMs: 5, retries: 0 });
    const rejection = timeoutClient.query([alpha], new AbortController().signal);
    await expect(rejection).rejects.toMatchObject({ code: "OSV_REQUEST_TIMEOUT" });
    await expect(rejection).rejects.not.toHaveProperty("cause");
  });

  it("rejects pagination cycles and page-limit exhaustion", async () => {
    const recorder = requestRecorder(() =>
      json({ results: [{ vulns: [], next_page_token: "same-token" }] }),
    );
    const client = createOsvClient({ fetch: recorder.fetch, retries: 0, maxPages: 2 });
    await expect(client.query([alpha], new AbortController().signal)).rejects.toMatchObject({
      code: "OSV_PAGINATION_INVALID",
    });
  });

  it("probes with a constant synthetic query", async () => {
    const recorder = requestRecorder(({ url }) =>
      url.endsWith("/v1/querybatch")
        ? json({ results: [{}] })
        : json({ id: "unused", affected: [] }),
    );
    await createOsvClient({ fetch: recorder.fetch, retries: 0 }).probe(
      new AbortController().signal,
    );
    expect(recorder.requests[0]?.body).toEqual({
      queries: [
        { package: { name: "@zedbee/osv-connectivity-probe", ecosystem: "npm" }, version: "0.0.0" },
      ],
    });
  });
});
