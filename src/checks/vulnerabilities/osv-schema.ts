import { z } from "zod";

const packageCoordinatesSchema = z
  .object({
    name: z.string().trim().min(1),
    version: z.string().trim().min(1),
    ecosystem: z.string().trim().min(1),
  })
  .passthrough();

const affectedSchema = z
  .object({
    package: z
      .object({
        name: z.string().optional(),
        ecosystem: z.string().optional(),
      })
      .passthrough()
      .optional(),
    ranges: z
      .array(
        z
          .object({
            events: z
              .array(
                z
                  .object({ fixed: z.string().trim().min(1).optional() })
                  .passthrough(),
              )
              .optional(),
          })
          .passthrough(),
      )
      .optional(),
  })
  .passthrough();

const vulnerabilitySchema = z
  .object({
    id: z.string().trim().min(1),
    severity: z.array(z.object({ score: z.string() }).passthrough()).optional(),
    affected: z.array(affectedSchema).optional(),
  })
  .passthrough();

const resultPackageSchema = z
  .object({
    package: packageCoordinatesSchema,
    vulnerabilities: z.array(vulnerabilitySchema).optional(),
  })
  .passthrough();

export const osvReportSchema = z
  .object({
    results: z.array(
      z
        .object({
          source: z.object({ path: z.string().trim().min(1) }).passthrough(),
          packages: z.array(resultPackageSchema),
        })
        .passthrough(),
    ),
  })
  .passthrough();

export type OsvReport = z.infer<typeof osvReportSchema>;
export type OsvVulnerability = z.infer<typeof vulnerabilitySchema>;
