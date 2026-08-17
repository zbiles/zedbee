import pLimit from "p-limit";
import { validateExactVersion, validatePackageName } from "../inventory/normalize.js";
import {
  OsvAnalysisError,
  OsvUnavailableError,
} from "./errors.js";
import { readJsonResponse } from "./read-response.js";
import {
  advisoryResponseSchema,
  batchResponseSchema,
  type ParsedAdvisoryResponse,
} from "./schemas.js";
import type {
  OsvAdvisory,
  OsvClient,
  OsvPackageQuery,
  OsvRangeEvent,
} from "./types.js";

const OSV_ORIGIN = "https://api.osv.dev";
const QUERY_BATCH_URL = `${OSV_ORIGIN}/v1/querybatch`;
const DEFAULT_BATCH_SIZE = 1_000;
const MAX_QUERIES = 20_000;
const PROBE_QUERY: OsvPackageQuery = Object.freeze({
  name: "@zedbee/osv-connectivity-probe",
  version: "0.0.0",
  ecosystem: "npm",
});

type FetchImplementation = typeof globalThis.fetch;

export interface OsvClientOptions {
  readonly fetch?: FetchImplementation;
  readonly timeoutMs?: number;
  readonly retries?: number;
  readonly retryDelay?: (attempt: number) => Promise<void>;
  readonly batchSize?: number;
  readonly detailConcurrency?: number;
  readonly maxPages?: number;
}

interface QueryEntry {
  readonly query: OsvPackageQuery;
  readonly key: string;
  readonly pageToken?: string;
  readonly pages: number;
  readonly seenTokens: ReadonlySet<string>;
}

export function osvQueryKey(query: OsvPackageQuery): string {
  return JSON.stringify([query.ecosystem, query.name, query.version]);
}

function safeQuery(query: OsvPackageQuery): OsvPackageQuery {
  if (query.ecosystem !== "npm") {
    throw new OsvAnalysisError(
      "OSV_RESPONSE_INVALID",
      "Zedbee received an unsupported OSV package ecosystem.",
    );
  }
  try {
    return Object.freeze({
      name: validatePackageName(query.name),
      version: validateExactVersion(query.version),
      ecosystem: "npm",
    });
  } catch {
    throw new OsvAnalysisError(
      "OSV_RESPONSE_INVALID",
      "Zedbee received an invalid OSV package query.",
    );
  }
}

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function unavailableForStatus(status: number): OsvUnavailableError | undefined {
  if (status === 429) {
    return new OsvUnavailableError(
      "OSV_RATE_LIMITED",
      "OSV temporarily rate-limited the vulnerability request.",
    );
  }
  if (status >= 500 && status <= 599) {
    return new OsvUnavailableError(
      "OSV_SERVICE_UNAVAILABLE",
      "OSV is temporarily unavailable.",
    );
  }
  return undefined;
}

function normalizeAdvisory(parsed: ParsedAdvisoryResponse): OsvAdvisory {
  return Object.freeze({
    id: parsed.id,
    aliases: Object.freeze([...(parsed.aliases ?? [])]),
    affected: Object.freeze(
      parsed.affected.map((affected) =>
        Object.freeze({
          package: Object.freeze({ ...affected.package }),
          ranges: Object.freeze(
            (affected.ranges ?? []).map((range) =>
              Object.freeze({
                type: range.type,
                events: Object.freeze(
                  range.events.map((event) => {
                    const normalized: OsvRangeEvent = Object.freeze({
                      ...(event.introduced === undefined
                        ? {}
                        : { introduced: event.introduced }),
                      ...(event.fixed === undefined ? {} : { fixed: event.fixed }),
                      ...(event.last_affected === undefined
                        ? {}
                        : { lastAffected: event.last_affected }),
                      ...(event.limit === undefined ? {} : { limit: event.limit }),
                    });
                    return normalized;
                  }),
                ),
              }),
            ),
          ),
          versions: Object.freeze([...(affected.versions ?? [])]),
        }),
      ),
    ),
    severity: Object.freeze(
      (parsed.severity ?? []).map((severity) => Object.freeze({ ...severity })),
    ),
    references: Object.freeze(
      (parsed.references ?? []).map((reference) => Object.freeze({ ...reference })),
    ),
  });
}

export function createOsvClient(options: OsvClientOptions = {}): OsvClient {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const retries = options.retries ?? 2;
  const retryDelay = options.retryDelay ?? (async () => Promise.resolve());
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  const detailConcurrency = options.detailConcurrency ?? 4;
  const maxPages = options.maxPages ?? 10;

  const request = async (
    url: string,
    init: Omit<RequestInit, "signal" | "redirect">,
    signal: AbortSignal,
  ): Promise<unknown> => {
    for (let attempt = 0; ; attempt += 1) {
      const timeout = new AbortController();
      const timeoutHandle = setTimeout(() => timeout.abort(), timeoutMs);
      const combinedSignal = AbortSignal.any([signal, timeout.signal]);
      try {
        const response = await fetchImpl(url, {
          ...init,
          redirect: "manual",
          signal: combinedSignal,
        });
        if (response.status >= 300 && response.status <= 399) {
          throw new OsvAnalysisError(
            "OSV_REDIRECT_REJECTED",
            "OSV returned an unexpected redirect.",
          );
        }
        const unavailable = unavailableForStatus(response.status);
        if (unavailable !== undefined) throw unavailable;
        if (!response.ok) {
          throw new OsvAnalysisError(
            "OSV_HTTP_REJECTED",
            "OSV rejected the vulnerability request.",
          );
        }
        return await readJsonResponse(response);
      } catch (error) {
        let safeError: OsvUnavailableError | OsvAnalysisError;
        if (error instanceof OsvUnavailableError || error instanceof OsvAnalysisError) {
          safeError = error;
        } else if (signal.aborted) {
          safeError = new OsvUnavailableError(
            "OSV_REQUEST_ABORTED",
            "The OSV request was cancelled.",
          );
        } else if (timeout.signal.aborted) {
          safeError = new OsvUnavailableError(
            "OSV_REQUEST_TIMEOUT",
            "OSV did not respond before the request deadline.",
          );
        } else {
          safeError = new OsvUnavailableError(
            "OSV_NETWORK_UNAVAILABLE",
            "Zedbee could not connect to OSV.",
          );
        }
        if (
          safeError instanceof OsvAnalysisError ||
          safeError.code === "OSV_REQUEST_ABORTED" ||
          attempt >= retries
        ) {
          throw safeError;
        }
        await retryDelay(attempt + 1);
      } finally {
        clearTimeout(timeoutHandle);
      }
    }
  };

  const queryBatch = async (
    entries: readonly QueryEntry[],
    signal: AbortSignal,
  ) => {
    const raw = await request(
      QUERY_BATCH_URL,
      {
        method: "POST",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          queries: entries.map(({ query, pageToken }) => ({
            package: { name: query.name, ecosystem: query.ecosystem },
            version: query.version,
            ...(pageToken === undefined ? {} : { page_token: pageToken }),
          })),
        }),
      },
      signal,
    );
    const parsed = batchResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.results.length !== entries.length) {
      throw new OsvAnalysisError(
        "OSV_RESPONSE_INVALID",
        "OSV returned an invalid batch response.",
      );
    }
    return parsed.data.results;
  };

  const fetchAdvisory = async (id: string, signal: AbortSignal) => {
    const raw = await request(
      `${OSV_ORIGIN}/v1/vulns/${encodeURIComponent(id)}`,
      { method: "GET", headers: { accept: "application/json" } },
      signal,
    );
    const parsed = advisoryResponseSchema.safeParse(raw);
    if (!parsed.success || parsed.data.id !== id) {
      throw new OsvAnalysisError(
        "OSV_RESPONSE_INVALID",
        "OSV returned an invalid advisory response.",
      );
    }
    return normalizeAdvisory(parsed.data);
  };

  const query = async (
    packages: readonly OsvPackageQuery[],
    signal: AbortSignal,
  ): Promise<ReadonlyMap<string, readonly OsvAdvisory[]>> => {
    if (packages.length > MAX_QUERIES) {
      throw new OsvAnalysisError(
        "OSV_QUERY_LIMIT_EXCEEDED",
        "The dependency inventory contains too many OSV queries.",
      );
    }
    const unique = new Map<string, OsvPackageQuery>();
    for (const candidate of packages) {
      const safe = safeQuery(candidate);
      const key = osvQueryKey(safe);
      if (!unique.has(key)) unique.set(key, safe);
    }
    const idsByKey = new Map<string, Set<string>>(
      [...unique.keys()].map((key) => [key, new Set()]),
    );
    let pending: QueryEntry[] = [...unique].map(([key, packageQuery]) => ({
      key,
      query: packageQuery,
      pages: 1,
      seenTokens: new Set(),
    }));
    while (pending.length > 0) {
      const next: QueryEntry[] = [];
      for (const batch of chunks(pending, batchSize)) {
        const results = await queryBatch(batch, signal);
        results.forEach((result, index) => {
          const entry = batch[index];
          if (entry === undefined) return;
          for (const vulnerability of result.vulns ?? []) {
            idsByKey.get(entry.key)?.add(vulnerability.id);
          }
          const token = result.next_page_token;
          if (token === undefined) return;
          if (entry.seenTokens.has(token) || entry.pages >= maxPages) {
            throw new OsvAnalysisError(
              "OSV_PAGINATION_INVALID",
              "OSV returned invalid or excessive pagination data.",
            );
          }
          next.push({
            ...entry,
            pageToken: token,
            pages: entry.pages + 1,
            seenTokens: new Set([...entry.seenTokens, token]),
          });
        });
      }
      pending = next;
    }

    const allIds = [...new Set([...idsByKey.values()].flatMap((ids) => [...ids]))].sort();
    const limit = pLimit(detailConcurrency);
    const advisoryEntries = await Promise.all(
      allIds.map((id) => limit(async () => [id, await fetchAdvisory(id, signal)] as const)),
    );
    const advisories = new Map(advisoryEntries);
    const result = new Map<string, readonly OsvAdvisory[]>();
    for (const key of unique.keys()) {
      result.set(
        key,
        Object.freeze(
          [...(idsByKey.get(key) ?? [])]
            .sort()
            .flatMap((id) => {
              const advisory = advisories.get(id);
              return advisory === undefined ? [] : [advisory];
            }),
        ),
      );
    }
    return result;
  };

  return Object.freeze({
    query,
    async probe(signal: AbortSignal): Promise<void> {
      await query([PROBE_QUERY], signal);
    },
  });
}
