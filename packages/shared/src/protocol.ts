import { z } from 'zod';
import { modelUsageSchema, answerCitationListSchema } from '@trinity-harness/contracts';
export {
  answerCitationSchema,
  answerCitationListSchema,
  type AnswerCitation,
} from '@trinity-harness/contracts';

/**
 * ACP-flavored wire protocol between server and browser (docs/design.md §11).
 *
 * Kinds deliberately mirror ACP `session/update` variants (§11.4) so the M3
 * switch to the official ACP HTTP binding does not change message shapes —
 * only the transport framing around them.
 */

export const sessionUpdateSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent_message_chunk'),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('agent_thought_chunk'),
    text: z.string(),
  }),
  z.object({
    kind: z.literal('tool_call'),
    toolCallId: z.string(),
    title: z.string(),
    status: z.enum(['pending', 'in_progress', 'completed', 'failed']),
    /** Model-facing content of the result once finished (bounded). */
    content: z.string().optional(),
  }),
  /**
   * M3: human approval request (docs/design.md §12.2). Mirrors ACP
   * `session/request_permission`; the client answers via
   * POST /acp/permission-response (or the ACP client-side method).
   */
  z.object({
    kind: z.literal('permission_request'),
    approvalId: z.string(),
    toolCallId: z.string(),
    toolName: z.string(),
    title: z.string(),
    argsPreview: z.string().max(2000),
    status: z.enum(['pending', 'allowed', 'rejected']),
    decidedBy: z.string().optional(),
  }),
]);
export type SessionUpdate = z.infer<typeof sessionUpdateSchema>;

/** One committed message in the UI surface. */
export const surfaceMessageSchema = z.object({
  id: z.uuid().optional(),
  /** Timestamp of the committed session event; optional for older clients/servers. */
  at: z.iso.datetime().optional(),
  role: z.enum(['user', 'assistant']),
  content: z.string(),
  phase: z.enum(['progress', 'final']).optional(),
  citationList: answerCitationListSchema.optional(),
  /**
   * M4 multimodal: image/file references carried by the message (rendered by
   * the UI from the blob endpoint; `content` keeps the text fallback).
   */
  attachments: z
    .array(
      z.object({
        kind: z.enum(['image', 'file']),
        uri: z.string(),
        mimeType: z.string().optional(),
      }),
    )
    .optional(),
});
export type SurfaceMessage = z.infer<typeof surfaceMessageSchema>;

export const serverEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('model/usage'), sessionId: z.string(), usage: modelUsageSchema }),
  z.object({
    type: z.literal('session/update'),
    sessionId: z.string(),
    update: sessionUpdateSchema,
  }),
  z.object({
    type: z.literal('message/committed'),
    sessionId: z.string(),
    message: surfaceMessageSchema,
  }),
  z.object({
    type: z.literal('error'),
    sessionId: z.string().optional(),
    message: z.string(),
  }),
  /**
   * M3: turn lifecycle signal independent of message commits — e.g. an
   * approval was decided while the turn keeps running, or a turn started.
   */
  z.object({
    type: z.literal('session/turn_status'),
    sessionId: z.string(),
    status: z.enum(['running', 'awaiting_approval', 'completed', 'aborted']),
    detail: z.string().optional(),
  }),
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;

export const turnCancelResponseSchema = z.object({
  ok: z.literal(true),
  alreadyStopped: z.boolean(),
});
export type TurnCancelResponse = z.infer<typeof turnCancelResponseSchema>;

/** Conversation-scoped literal command-prefix approval. */
export const approvalResponseSchema = z
  .object({
    outcome: z.enum(['allowed', 'rejected']),
    commandPrefix: z
      .array(
        z
          .string()
          .min(1)
          .max(500)
          .regex(/^[a-zA-Z0-9_./:@=+-]+$/),
      )
      .min(1)
      .max(32)
      .optional(),
  })
  .refine((value) => value.commandPrefix === undefined || value.outcome === 'allowed', {
    message: 'Only allowed requests can grant a command prefix',
  });
