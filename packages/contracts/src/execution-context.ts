import { z } from 'zod';

export const effectScopeSchema = z.enum([
  'workspace',
  'browser',
  'reference',
  'control',
  'unknown',
]);
export const toolEffectSchema = z.object({
  kind: z.enum(['read', 'navigation', 'mutation', 'unknown']),
  scope: effectScopeSchema,
  evidence: z.enum(['none', 'observation', 'immutable-observation']).optional(),
});
export type ToolEffect = z.infer<typeof toolEffectSchema>;
export const contextSectionKindSchema = z.enum(['reference', 'control']);
export type ContextSectionKind = z.infer<typeof contextSectionKindSchema>;

export const sourceExcerptSchema = z.object({
  eventId: z.uuid(),
  seq: z.number().int().positive(),
  from: z.number().int().nonnegative(),
  to: z.number().int().nonnegative(),
  totalCharacters: z.number().int().nonnegative(),
  text: z.string().max(64_000),
  attachments: z
    .array(
      z.object({
        kind: z.enum(['image', 'file']),
        uri: z.string().max(2000),
        mimeType: z.string().max(100).optional(),
        workspacePath: z.string().max(500).optional(),
      }),
    )
    .max(32)
    .optional(),
});

export const executionContextEventSchemas = [
  z.object({
    type: z.literal('model/context'),
    promptId: z.uuid(),
    requestId: z.uuid(),
    version: z.literal(2),
    purpose: z.enum(['assistant', 'compaction']),
    sourceToSeq: z.number().int().nonnegative(),
    selectionEventId: z.uuid().optional(),
    digest: z.string().regex(/^[a-f0-9]{64}$/),
    bytes: z.number().int().nonnegative(),
    /** Private artifact; never exposed by generic blob routes or tools. */
    snapshotUri: z.string().startsWith('blob://model-context/').optional(),
  }),
  z.object({
    type: z.literal('response/candidate'),
    promptId: z.uuid(),
    planId: z.uuid().optional(),
    contextId: z.uuid().optional(),
    text: z.string(),
    failedConditions: z.array(z.string()).max(32),
  }),
] as const;
