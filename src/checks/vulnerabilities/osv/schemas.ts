import { z } from "zod";

const boundedText = z.string().min(1).max(8_192);
const idText = z.string().min(1).max(256);

const batchVulnerabilitySchema = z.object({
  id: idText,
  modified: boundedText.optional(),
});

export const batchResponseSchema = z.object({
  results: z
    .array(
      z.object({
        vulns: z.array(batchVulnerabilitySchema).max(10_000).optional(),
        next_page_token: z.string().min(1).max(2_048).optional(),
      }),
    )
    .max(1_000),
});

const rangeEventSchema = z.object({
  introduced: boundedText.optional(),
  fixed: boundedText.optional(),
  last_affected: boundedText.optional(),
  limit: boundedText.optional(),
});

export const advisoryResponseSchema = z.object({
  id: idText,
  aliases: z.array(idText).max(1_000).optional(),
  affected: z
    .array(
      z.object({
        package: z.object({
          name: boundedText,
          ecosystem: boundedText,
        }),
        ranges: z
          .array(
            z.object({
              type: boundedText,
              events: z.array(rangeEventSchema).max(10_000),
            }),
          )
          .max(1_000)
          .optional(),
        versions: z.array(boundedText).max(10_000).optional(),
      }),
    )
    .max(10_000),
  severity: z
    .array(z.object({ type: boundedText, score: boundedText }))
    .max(100)
    .optional(),
  references: z
    .array(z.object({ type: boundedText, url: boundedText }))
    .max(1_000)
    .optional(),
});

export type ParsedBatchResponse = z.infer<typeof batchResponseSchema>;
export type ParsedAdvisoryResponse = z.infer<typeof advisoryResponseSchema>;
