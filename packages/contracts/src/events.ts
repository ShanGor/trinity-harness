import { z } from 'zod';

/** Content blocks exchanged with the model (AI SDK-compatible shape). */
export const contentBlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('image'),
    uri: z.string(),
    mimeType: z.string().optional(),
  }),
  z.object({
    kind: z.literal('file'),
    uri: z.string(),
    mimeType: z.string().optional(),
  }),
]);
export type ContentBlock = z.infer<typeof contentBlockSchema>;

const baseFields = {
  eventId: z.uuid(),
  /** ISO-8601 UTC timestamp, set by the appending process. */
  at: z.iso.datetime(),
};

export const sessionCreatedEventSchema = z.object({
  ...baseFields,
  type: z.literal('session/created'),
  workspaceUri: z.string().min(1),
  forkedFrom: z.uuid().optional(),
});

export const turnStartEventSchema = z.object({
  ...baseFields,
  type: z.literal('turn/start'),
});

export const turnEndEventSchema = z.object({
  ...baseFields,
  type: z.literal('turn/end'),
  reason: z.enum(['completed', 'max-tokens', 'blocked', 'aborted', 'error']),
  detail: z.string().optional(),
});

export const userMessageEventSchema = z.object({
  ...baseFields,
  type: z.literal('message/user'),
  surfaceOp: z.literal('append'),
  content: z.array(contentBlockSchema),
});

export const assistantMessageEventSchema = z.object({
  ...baseFields,
  type: z.literal('message/assistant'),
  surfaceOp: z.enum(['append', 'replace']),
  content: z.array(contentBlockSchema),
});

export const toolCallEventSchema = z.object({
  ...baseFields,
  type: z.literal('tool/call'),
  callId: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown(),
});

export const toolResultEventSchema = z.object({
  ...baseFields,
  type: z.literal('tool/result'),
  callId: z.string().min(1),
  value: z.unknown(),
  isError: z.boolean(),
});

export const compactionSummaryEventSchema = z.object({
  ...baseFields,
  type: z.literal('compaction/summary'),
  fromSeq: z.number().int().positive(),
  toSeq: z.number().int().positive(),
  summary: z.string(),
});

/**
 * Session event log entry — discriminated union, zod-validated, append-only.
 * See docs/design.md §7.
 */
export const sessionEventSchema = z.discriminatedUnion('type', [
  sessionCreatedEventSchema,
  turnStartEventSchema,
  turnEndEventSchema,
  userMessageEventSchema,
  assistantMessageEventSchema,
  toolCallEventSchema,
  toolResultEventSchema,
  compactionSummaryEventSchema,
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventType = SessionEvent['type'];
