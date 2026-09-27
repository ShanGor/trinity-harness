import { z } from 'zod';

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
]);
export type SessionUpdate = z.infer<typeof sessionUpdateSchema>;

/** One committed message in the UI surface. */
export const surfaceMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string(),
});
export type SurfaceMessage = z.infer<typeof surfaceMessageSchema>;

export const serverEventSchema = z.discriminatedUnion('type', [
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
]);
export type ServerEvent = z.infer<typeof serverEventSchema>;
