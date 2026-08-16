import { z } from "zod";

const positiveLine = z.number().int().positive();
const positiveColumn = z.number().int().positive();

export const gitleaksFindingSchema = z
  .object({
    RuleID: z.string().trim().min(1),
    File: z.string().trim().min(1),
    StartLine: positiveLine,
    EndLine: positiveLine,
    StartColumn: positiveColumn,
    EndColumn: positiveColumn,
    Secret: z.string(),
  })
  .passthrough();

export const gitleaksReportSchema = z.array(gitleaksFindingSchema);

export type GitleaksFinding = z.infer<typeof gitleaksFindingSchema>;
