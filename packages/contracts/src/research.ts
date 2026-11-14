import { z } from 'zod';
import { browserSourceSchema } from './browser.js';

const sourceUrlSchema = z
  .url()
  .max(2000)
  .refine((value) => {
    if (!URL.canParse(value)) return false;
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password;
  }, 'Expected an HTTP(S) source URL without credentials');

export const researchPageSchema = z.object({
  kind: z.literal('trinity-research-page-v1'),
  url: sourceUrlSchema,
  title: z.string().max(1000),
  publishedAt: z.string().max(200).nullable(),
  text: z.string().max(24_000),
  truncated: z.boolean(),
  links: z.array(z.object({ title: z.string().max(200), url: sourceUrlSchema })).max(40),
});
export type ResearchPage = z.infer<typeof researchPageSchema>;

// Shared fields keep normalized receipts compatible with previously recorded notes.
const sourceReceiptSchema = z.object({
  callId: z.string().min(1).max(200).optional(),
  artifactUri: z.string().max(500).optional(),
  capturedAt: z.iso.datetime().optional(),
  evidenceSeq: z.number().int().positive().optional(),
  url: sourceUrlSchema.or(z.literal('')).default(''),
  quote: z.string().trim().max(600).default(''),
});
const observationSourceSchema = sourceReceiptSchema.extend({
  observationId: browserSourceSchema.shape.observationId,
  blockId: browserSourceSchema.shape.blockId,
});
// Express alternatives in JSON Schema as well as runtime validation. In particular,
// an incomplete observation reference must never fall through to URL/quote matching.
const researchSourceSchema = z.union([
  observationSourceSchema
    .extend({
      start: z.never().optional(),
      end: z.never().optional(),
    })
    .describe('A fully delivered block of at most 600 characters. Omit URL and quote.'),
  observationSourceSchema
    .extend({
      start: z.number().int().nonnegative(),
      end: z.number().int().positive(),
    })
    .refine((source) => source.end > source.start, 'Expected end greater than start')
    .describe(
      'A delivered half-open code-point range of at most 600 characters. Supply both start and end; omit URL and quote.',
    ),
  sourceReceiptSchema
    .extend({
      observationId: z.never().optional(),
      blockId: z.never().optional(),
      start: z.never().optional(),
      end: z.never().optional(),
      url: sourceUrlSchema,
      quote: z
        .string()
        .trim()
        .min(1)
        .max(600)
        .describe(
          'A short contiguous verbatim passage from this observed URL. Preserve punctuation and intervening text.',
        ),
    })
    .describe(
      'Legacy citation: supply an observed URL and nonempty verbatim quote, without observation fields.',
    ),
]);

export const researchNotesSchema = z.object({
  question: z.string().min(1).max(1000),
  findings: z
    .array(
      z.object({
        claim: z.string().min(1).max(1000),
        relation: z.enum(['supports', 'contradicts', 'context']),
        sources: z.array(researchSourceSchema).min(1).max(3),
      }),
    )
    .max(12),
  openQuestions: z.array(z.string().min(1).max(500)).max(8),
  readyToAnswer: z.boolean(),
});
export type ResearchNotes = z.infer<typeof researchNotesSchema>;
export const researchArgumentsSchema = z
  .object({
    action: z.enum(['status', 'record']),
    notes: researchNotesSchema.optional(),
  })
  .refine((args) => args.action !== 'record' || args.notes !== undefined, {
    message: 'record requires notes',
  });
export const researchResultSchema = z.object({
  kind: z.literal('research-notes'),
  validation: z
    .object({
      references: z.literal('matched-delivered-evidence'),
      claimSupport: z.literal('not-assessed'),
      readiness: z.literal('model-authored'),
    })
    .optional(),
  promptSeq: z.number().int().positive(),
  notes: researchNotesSchema.nullable(),
});
