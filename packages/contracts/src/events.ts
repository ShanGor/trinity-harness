import { z } from 'zod';

import { skillSummarySchema, skillSnapshotSchema } from './skills.js';
import { answerCitationListSchema } from './citations.js';

/** Content blocks exchanged with the model (AI SDK-compatible shape). */
export const contentBlockSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  /**
   * Model reasoning ("thinking") block, assistant messages only. Must be
   * replayed verbatim during active tool steps for reasoning models; finished
   * turns retain only their final text in model context. The provider
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

export const sessionClosedEventSchema = z.object({
  ...baseFields,
  type: z.literal('session/closed'),
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
  phase: z.enum(['progress', 'final']).optional(),
  citationList: answerCitationListSchema.optional(),
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

export const commandApprovalGrantedEventSchema = z.object({
  ...baseFields,
  type: z.literal('approval/command_granted'),
  approvalId: z.uuid(),
  prefix: z.array(z.string().min(1).max(500)).min(1).max(32),
  decidedBy: z.string().min(1),
});

export const turnGuidanceEventSchema = z.object({
  ...baseFields,
  type: z.literal('turn/guidance'),
  promptSeq: z.number().int().positive(),
  advice: z.string().min(1).max(2000),
});

export const turnCancelRequestedEventSchema = z.object({
  ...baseFields,
  type: z.literal('turn/cancel_requested'),
  throughPromptSeq: z.number().int().positive(),
});

export const skillCatalogEventSchema = z.object({
  ...baseFields,
  type: z.literal('skill/catalog'),
  skills: z.array(skillSummarySchema).max(128),
  instructions: z.string().max(150_000),
});
export const skillLoadedEventSchema = z.object({
  ...baseFields,
  type: z.literal('skill/loaded'),
  snapshot: skillSnapshotSchema,
});

/**
 * Session event log entry — discriminated union, zod-validated, append-only.
 * See docs/design.md §7.
 */
export const sessionEventSchema = z.discriminatedUnion('type', [
  skillCatalogEventSchema,
  skillLoadedEventSchema,
  sessionCreatedEventSchema,
  sessionClosedEventSchema,
  turnStartEventSchema,
  turnCancelRequestedEventSchema,
  turnGuidanceEventSchema,
  turnEndEventSchema,
  userMessageEventSchema,
  assistantMessageEventSchema,
  toolCallEventSchema,
  toolResultEventSchema,
  compactionSummaryEventSchema,
  approvalRequestedEventSchema,
  approvalResolvedEventSchema,
  commandApprovalGrantedEventSchema,
]);
export type SessionEvent = z.infer<typeof sessionEventSchema>;
export type SessionEventType = SessionEvent['type'];
