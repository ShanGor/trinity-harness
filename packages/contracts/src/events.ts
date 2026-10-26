import { permissionPolicySchema } from './approval.js';
import { personalContextEventSchema } from './personal-assistant.js';
import { z } from 'zod';
import { modelUsageSchema } from './usage.js';
import { taskEventSchemas } from './task.js';
import { executionContextEventSchemas, toolEffectSchema } from './execution-context.js';

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

export const modelUsageEventSchema = z.object({
  ...baseFields,
  type: z.literal('model/usage'),
  usage: modelUsageSchema,
});

export const sessionCreatedEventSchema = z.object({
  ...baseFields,
  type: z.literal('session/created'),
  workspaceUri: z.string().min(1).nullable(),
  kind: z.enum(['chat', 'work']).optional(),
  sessionRole: z.enum(['main', 'side', 'task']).optional(),
  creationOperationId: z.uuid().optional(),
  originSessionId: z.uuid().optional(),
  forkedFrom: z.uuid().optional(),
});

export const sessionClosedEventSchema = z.object({
  ...baseFields,
  type: z.literal('session/closed'),
});

/** One-time workspace allocation for Chat sessions created before automatic workspaces. */
export const sessionWorkspaceBoundEventSchema = z.object({
  ...baseFields,
  type: z.literal('session/workspace_bound'),
  workspaceUri: z.string().min(1),
});

export const sessionAttachmentEventSchema = z.object({
  ...baseFields,
  type: z.literal('session/attachment'),
  uri: z.string().startsWith('blob://'),
  workspacePath: z.string().min(1).max(500),
  mimeType: z.string().min(1).max(100),
  size: z.number().int().nonnegative(),
});

export const turnStartEventSchema = z.object({
  ...baseFields,
  type: z.literal('turn/start'),
  promptId: z.uuid().optional(),
  executionVersion: z.literal(2).optional(),
});

export const turnEndEventSchema = z.object({
  ...baseFields,
  type: z.literal('turn/end'),
  promptId: z.uuid().optional(),
  reason: z.enum(['completed', 'max-tokens', 'blocked', 'aborted', 'error']),
  detail: z.string().optional(),
});

export const userMessageEventSchema = z.object({
  ...baseFields,
  type: z.literal('message/user'),
  surfaceOp: z.literal('append'),
  content: z.array(contentBlockSchema),
  trigger: scheduleTriggerSchema.optional(),
});

export const assistantMessageEventSchema = z.object({
  ...baseFields,
  type: z.literal('message/assistant'),
  surfaceOp: z.enum(['append', 'replace']),
  phase: z.enum(['progress', 'final']).optional(),
  /** Partial answer retained for bounded stream/output-limit continuation. */
  continuation: z.boolean().optional(),
  citationList: answerCitationListSchema.optional(),
  content: z.array(contentBlockSchema),
});

export const toolCallEventSchema = z.object({
  ...baseFields,
  type: z.literal('tool/call'),
  effect: toolEffectSchema.optional(),
  callId: z.string().min(1),
  name: z.string().min(1),
  args: z.unknown(),
});

export const toolResultEventSchema = z.object({
  ...baseFields,
  type: z.literal('tool/result'),
  effect: toolEffectSchema.optional(),
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
  /** A rolling checkpoint incorporates all previous summaries. */
  checkpoint: z.boolean().optional(),
  memoryPromptId: z.uuid().optional(),
  memoryPolicyRevision: z.number().int().nonnegative().optional(),
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
export const activityReferenceEventSchema = z.object({
  ...baseFields,
  type: z.literal('activity/reference'),
  sourceSessionId: z.uuid(),
  sourceEventId: z.uuid(),
  kind: z.enum(['chat', 'work']),
});

export const queuedPromptEventSchema = z.object({
  ...baseFields,
  type: z.literal('prompt/queued'),
  promptId: z.uuid(),
  content: z.array(contentBlockSchema).min(1).max(10),
  actor: z.string().max(200),
  tenantId: z.uuid(),
  policy: permissionPolicySchema,
  trigger: scheduleTriggerSchema.optional(),
});
export const discardedPromptEventSchema = z.object({
  ...baseFields,
  type: z.literal('prompt/discarded'),
  promptId: z.uuid(),
  reason: z.literal('cancelled'),
});

export const sessionEventSchema = z.discriminatedUnion('type', [
  z.object({
    ...baseFields,
    type: z.literal('browser/control_changed'),
    generation: z.uuid(),
    epoch: z.number().int().nonnegative(),
    mode: z.enum(['agent', 'human', 'paused', 'quarantined']),
  }),
  z.object({
    ...baseFields,
    type: z.literal('browser/user_input'),
    generation: z.uuid(),
    epoch: z.number().int().nonnegative(),
    requestId: z.uuid(),
    effect: z.enum(['applied', 'unknown']),
  }),
  z.object({
    ...baseFields,
    type: z.literal('browser/runtime_bound'),
    generation: z.uuid(),
    engine: z.literal('zendriver'),
    upstreamVersion: z.string().max(100),
    securityMode: z.literal('trusted-managed'),
  }),
  activityReferenceEventSchema,
  queuedPromptEventSchema,
  discardedPromptEventSchema,
  personalContextEventSchema,
  modelUsageEventSchema,
  ...taskEventSchemas.map((schema) => schema.extend(baseFields)),
  ...executionContextEventSchemas.map((schema) => schema.extend(baseFields)),
  skillCatalogEventSchema,
  skillLoadedEventSchema,
  sessionCreatedEventSchema,
  sessionClosedEventSchema,
  sessionWorkspaceBoundEventSchema,
  sessionAttachmentEventSchema,
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
import { scheduleTriggerSchema } from './scheduling.js';
