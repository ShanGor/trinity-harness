import { z } from 'zod';

/** Content blocks exchanged with the model (AI SDK-compatible shape). */
export const contentBlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  /**
   * Model reasoning ("thinking") block, assistant messages only. Must be
   * replayed verbatim on subsequent turns for reasoning models (MiniMax-M3
   * requires the last reasoning output in chat history); the provider
   * signature is kept when the provider returns one (Anthropic format).
   */
  z.object({
    kind: z.literal('reasoning'),
    text: z.string(),
    signature: z.string().optional(),
  }),
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

export const approvalRequestedEventSchema = z.object({
  ...baseFields,
  type: z.literal('approval/requested'),
  approvalId: z.uuid(),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  argsPreview: z.string().max(2000),
});

export const approvalResolvedEventSchema = z.object({
  ...baseFields,
  type: z.literal('approval/resolved'),
  approvalId: z.uuid(),
  outcome: z.enum(['allowed', 'rejected']),
  decidedBy: z.string().min(1),
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
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventType = SessionEvent['type'];
