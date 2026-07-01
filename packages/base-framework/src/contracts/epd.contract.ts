/**
 * The EPD data contract. Every extraction and every read of an extraction
 * validates against this schema. Persisted as JSONB in `extractions.epd_data`.
 *
 * The load-bearing invariant is the `StageValue` discriminated union: a
 * life-cycle stage is either { declared: true, gwpTotal, … } or
 * { declared: false, reason? }. There is no third state where the UI can
 * silently render 0. "Not declared ≠ zero" is enforced by shape.
 */
import { z } from 'zod';

export const provenanceConfidence = z.enum(['high', 'medium', 'low']);
export type ProvenanceConfidence = z.infer<typeof provenanceConfidence>;

export const provenanceMethod = z.enum(['vision-llm', 'text-llm', 'manual', 'derived']);
export type ProvenanceMethod = z.infer<typeof provenanceMethod>;

/** A page + verbatim snippet that grounds a single extracted value. */
export const provenance = z.object({
  pageNumber: z.number().int().positive(),
  snippet: z.string().min(1),
  confidence: provenanceConfidence,
  method: provenanceMethod,
  boundingBox: z
    .object({ x: z.number(), y: z.number(), w: z.number(), h: z.number() })
    .optional(),
});
export type Provenance = z.infer<typeof provenance>;

export const LCA_STAGES = [
  'A1-A3',
  'A4',
  'A5',
  'B1',
  'B2',
  'B3',
  'B4',
  'B5',
  'B6',
  'B7',
  'C1',
  'C2',
  'C3',
  'C4',
  'D',
] as const;
export type LcaStage = (typeof LCA_STAGES)[number];

export const stageValue = z.discriminatedUnion('declared', [
  z.object({
    declared: z.literal(true),
    gwpTotal: z.number(),
    gwpFossil: z.number().nullable().optional(),
    gwpBiogenic: z.number().nullable().optional(),
    gwpLuluc: z.number().nullable().optional(),
    unit: z.string().default('kg CO2 eq.'),
    provenance,
  }),
  z.object({
    declared: z.literal(false),
    reason: z.string().nullable().optional(),
  }),
]);
export type StageValue = z.infer<typeof stageValue>;

const provField = <T extends z.ZodTypeAny>(value: T) => z.object({ value, provenance });

export const epdPayload = z.object({
  manufacturer: provField(z.string()),
  productName: provField(z.string()),
  declarationNumber: provField(z.string()).nullable().optional(),
  publishedDate: z.string().nullable().optional(),
  validUntil: z.string().nullable().optional(),

  standard: z.object({
    name: z.string(),
    pcr: z.string().nullable().optional(),
    provenance,
  }),

  functionalUnit: z.object({
    quantity: z.number().positive(),
    unit: z.string(),
    provenance,
  }),

  compressiveStrength: z
    .object({
      valueMpa: z.number().nullable(),
      strengthClass: z.string().nullable(),
      testAgeDays: z.number().nullable().optional(),
      provenance,
    })
    .nullable()
    .optional(),

  manufacturingLocation: z.object({
    plant: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    region: z.string().nullable().optional(),
    country: z.string(),
    provenance,
  }),

  lifeCycle: z.object({
    'A1-A3': stageValue.optional(),
    A4: stageValue.optional(),
    A5: stageValue.optional(),
    B1: stageValue.optional(),
    B2: stageValue.optional(),
    B3: stageValue.optional(),
    B4: stageValue.optional(),
    B5: stageValue.optional(),
    B6: stageValue.optional(),
    B7: stageValue.optional(),
    C1: stageValue.optional(),
    C2: stageValue.optional(),
    C3: stageValue.optional(),
    C4: stageValue.optional(),
    D: stageValue.optional(),
  }),

  notes: z.array(z.string()).default([]),
});
export type EpdPayload = z.infer<typeof epdPayload>;

export function isDeclared(s: StageValue | undefined): s is Extract<StageValue, { declared: true }> {
  return !!s && s.declared === true;
}
