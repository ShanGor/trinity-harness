import { z } from 'zod';
import { browserSourceSchema } from './browser.js';

const sourceUrlSchema = z
  .url()
  .max(2000)
  .refine((value) => {
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

export const researchNotesSchema = z.object({
  question: z.string().min(1).max(1000),
  findings: z
    .array(
      z.object({
        claim: z.string().min(1).max(1000),
        relation: z.enum(['supports', 'contradicts', 'context']),
        sources: z
          .array(
            z
              .object({
                callId: z
                  .string()
                  .min(1)
                  .max(200)
                  .optional()
                  .describe(
                    'Optional extraction call ID; omitted IDs are resolved by exact observed URL and quote',
                  ),
                ...browserSourceSchema.partial().shape,
                artifactUri: z.string().max(500).optional(),
                capturedAt: z.iso.datetime().optional(),
                evidenceSeq: z.number().int().positive().optional(),
                url: sourceUrlSchema.or(z.literal('')).default(''),
                quote: z
                  .string()
                  .trim()
                  .max(600)
                  .describe(
                    'Copy a short contiguous passage verbatim from the extracted text. Preserve punctuation, including fullwidth ： and curly quotes. Do not paraphrase, translate, or omit intervening text. Whitespace differences are accepted.',
                  )
                  .default(''),
              })
              .refine(
                (source) =>
                  source.observationId && source.blockId
                    ? (source.start === undefined && source.end === undefined) ||
                      (source.start !== undefined &&
                        source.end !== undefined &&
                        source.end > source.start)
                    : !source.observationId &&
                      !source.blockId &&
                      source.url.length > 0 &&
                      source.quote.trim().length > 0,
                'Use an observation/block reference or an observed URL and nonempty quote',
              ),
          )
          .min(1)
          .max(3),
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
  promptSeq: z.number().int().positive(),
  notes: researchNotesSchema.nullable(),
});
