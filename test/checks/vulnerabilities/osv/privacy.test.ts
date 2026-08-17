import { describe, expect, it } from "vitest";
import { createOsvClient } from "../../../../src/checks/vulnerabilities/osv/client.js";

describe("OSV request privacy", () => {
  it("serializes only package name, ecosystem, exact version, and owned page tokens", async () => {
    const bodies: unknown[] = [];
    const fetch = (async (_input: string | URL | Request, init: RequestInit = {}) => {
      bodies.push(JSON.parse(String(init.body)) as unknown);
      return new Response(JSON.stringify({ results: [{}] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const hostile = {
      name: "safe-package",
      version: "1.2.3",
      ecosystem: "npm" as const,
      path: "/Users/private/repository/package-lock.json",
      repository: "secret-repository",
      remote: "git@example.com:private/repo.git",
      source: "const secret = 'token'",
      user: "private-user",
      fileHash: "private-hash",
    };

    await createOsvClient({ fetch, retries: 0 }).query(
      [hostile],
      new AbortController().signal,
    );

    expect(bodies).toEqual([
      {
        queries: [
          {
            package: { name: "safe-package", ecosystem: "npm" },
            version: "1.2.3",
          },
        ],
      },
    ]);
    const serialized = JSON.stringify(bodies);
    expect(serialized).not.toMatch(/private|repository|remote|source|user|hash|token/i);
  });

  it("uses only fixed HTTPS OSV endpoints with manual redirect handling", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (input: string | URL | Request, init: RequestInit = {}) => {
      requests.push({ url: String(input), init });
      return new Response(JSON.stringify({ results: [{}] }), {
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    await createOsvClient({ fetch, retries: 0 }).query(
      [{ name: "safe", version: "1.0.0", ecosystem: "npm" }],
      new AbortController().signal,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.osv.dev/v1/querybatch");
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: { accept: "application/json", "content-type": "application/json" },
    });
  });

  it("never exposes raw response bodies or underlying exception messages", async () => {
    const secrets = ["private-response-token", "private-dns-host"];
    const clients = [
      createOsvClient({
        fetch: (async () =>
          new Response(`{${secrets[0]}`, {
            headers: { "content-type": "application/json" },
          })) as typeof fetch,
        retries: 0,
      }),
      createOsvClient({
        fetch: (async () => {
          throw new Error(secrets[1]);
        }) as typeof fetch,
        retries: 0,
      }),
    ];
    for (const client of clients) {
      const error = await client
        .query(
          [{ name: "safe", version: "1.0.0", ecosystem: "npm" }],
          new AbortController().signal,
        )
        .catch((caught: unknown) => caught);
      expect(JSON.stringify(error)).not.toContain("private-");
      expect(String(error)).not.toContain("private-");
    }
  });
});
