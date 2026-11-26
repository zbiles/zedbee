import type { ParsedAdvisoryResponse } from "./schemas.js";
import type { OsvAdvisory, OsvRangeEvent } from "./types.js";

export function normalizeAdvisory(parsed: ParsedAdvisoryResponse): OsvAdvisory {
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
                      ...(event.fixed === undefined
                        ? {}
                        : { fixed: event.fixed }),
                      ...(event.last_affected === undefined
                        ? {}
                        : { lastAffected: event.last_affected }),
                      ...(event.limit === undefined
                        ? {}
                        : { limit: event.limit }),
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
      (parsed.references ?? []).map((reference) =>
        Object.freeze({ ...reference }),
      ),
    ),
  });
}
