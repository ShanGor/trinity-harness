import { z } from 'zod';
import type { Identity, SessionMeta } from './identity.js';
import type { ConversationMessage } from './llm.js';
import { sourceExcerptSchema } from './execution-context.js';

export const memorySourceSchema = z.object({
  sessionId: z.uuid(),
  eventId: z.uuid(),
  excerpt: z.string().max(4000),
  at: z.iso.datetime().optional(),
});
export const savedMemorySchema = z.object({
  memoryId: z.uuid(),
  revision: z.number().int().positive(),
  subject: z.string().min(1).max(200),
  predicate: z.string().min(1).max(200),
  value: z.string().min(1).max(2000),
  status: z.enum(['active', 'forgotten']),
  recordedAt: z.iso.datetime(),
  source: memorySourceSchema.optional(),
});
export type SavedMemory = z.infer<typeof savedMemorySchema>;
export const memoryCommandSchema = z
  .object({
    operationId: z.uuid(),
    memoryId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    operation: z.enum(['save', 'forget']),
    subject: z.string().min(1).max(200),
    predicate: z.string().min(1).max(200),
    value: z.string().min(1).max(2000),
    source: memorySourceSchema.optional(),
  })
  .strict();
export type MemoryCommand = z.infer<typeof memoryCommandSchema>;
export const memorySnapshotSchema = z.object({
  revision: z.number().int().nonnegative(),
  items: z.array(savedMemorySchema).max(500),
  hasSuppression: z.boolean(),
});
export type MemorySnapshot = z.infer<typeof memorySnapshotSchema>;
export interface MemoryStorePort {
  snapshot(identity: Identity): Promise<MemorySnapshot>;
  change(identity: Identity, command: MemoryCommand): Promise<SavedMemory>;
  changeMany?(identity: Identity, commands: readonly MemoryCommand[]): Promise<SavedMemory[]>;
}
export const topicEpisodeSchema = z.object({
  episodeId: z.string().min(1).max(200),
  topic: z.string().min(1).max(200),
  sessionId: z.uuid(),
  promptId: z.uuid(),
  fromSeq: z.number().int().positive(),
  toSeq: z.number().int().positive(),
  at: z.iso.datetime(),
  request: z.string().max(4000),
  outcome: z.string().max(6000),
  excluded: z.boolean(),
  policyRevision: z.number().int().nonnegative().default(0),
  answerSeq: z.number().int().positive().optional(),
});
export type TopicEpisode = z.infer<typeof topicEpisodeSchema>;
export const historyQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(50).default(20),
  query: z.string().max(200).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  timezone: z.string().max(100).default('UTC'),
});
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export interface ConversationIndexPort {
  evidence?(identity: Identity, episodeId: string): Promise<TopicEpisode | null>;
  history(
    identity: Identity,
    query: HistoryQuery,
  ): Promise<{ episodes: TopicEpisode[]; nextBefore: number | null }>;
  revise(
    identity: Identity,
    episodeId: string,
    change: { topic?: string; excluded?: boolean },
  ): Promise<void>;
}
export const recallReceiptSchema = z.object({
  version: z.literal(2).optional(),
  query: z.string().max(200).optional(),
  dialogue: z
    .array(
      z.object({
        promptId: z.uuid(),
        request: sourceExcerptSchema,
        answer: sourceExcerptSchema,
      }),
    )
    .max(6)
    .optional(),
  promptId: z.uuid(),
  policyRevision: z.number().int().nonnegative(),
  memories: z.array(savedMemorySchema).max(100),
  episodes: z.array(topicEpisodeSchema).max(10),
  omitted: z.boolean(),
  commandResult: z.string().max(4000).optional(),
  interruptedTurns: z
    .array(
      z.object({
        promptId: z.uuid(),
        fromSeq: z.number().int().positive(),
        toSeq: z.number().int().positive(),
        request: z.string().max(4000),
        reason: z.enum(['error', 'aborted', 'interrupted']),
      }),
    )
    .max(4)
    .optional(),
});
export type RecallReceipt = z.infer<typeof recallReceiptSchema>;
export const recallResultSchema = z.object({
  policyRevision: z.number().int().nonnegative(),
  episodes: z.array(topicEpisodeSchema).max(10).optional(),
  episodeId: z.string().optional(),
  sources: z
    .array(
      sourceExcerptSchema.extend({
        sessionId: z.uuid(),
        at: z.iso.datetime(),
        truncated: z.boolean(),
      }),
    )
    .max(2)
    .optional(),
});
export interface PersonalContextPort {
  validate?(meta: SessionMeta, receipt: RecallReceipt, signal?: AbortSignal): Promise<void>;
  select(
    meta: SessionMeta,
    promptId: string,
    query: string,
    signal?: AbortSignal,
    sourceAt?: string,
    dialogueCharacters?: number,
  ): Promise<RecallReceipt>;
}
export const personalContextEventSchema = z.object({
  type: z.literal('memory/selection'),
  eventId: z.uuid(),
  at: z.iso.datetime(),
  receipt: recallReceiptSchema,
});
export interface ContextSelection {
  receipt: RecallReceipt;
  messages: ConversationMessage[];
}

/** Topic metadata never determines the current task. */
export function suggestTopic(
  request: string,
  prior: readonly { topic: string; request: string }[],
): string {
  const explicit = /^(?:unrelated|new topic|switching topics)\s*[:：-]\s*(.+)/is.exec(request);
  if (explicit) return explicit[1]!.trim().slice(0, 120) || 'Untitled topic';
  const words = (text: string): Set<string> =>
    new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? []);
  const wanted = words(request);
  const matches = prior
    .map((item) => ({
      item,
      score: [...words(`${item.topic} ${item.request}`)].filter((word) => wanted.has(word)).length,
    }))
    .sort((a, b) => b.score - a.score);
  if ((matches[0]?.score ?? 0) >= 2) return matches[0]!.item.topic;
  if (/^(back to|returning to|continue)\b/i.test(request) && matches[0]?.score)
    return matches[0].item.topic;
  return request.trim().slice(0, 120) || 'Untitled topic';
}

export const episodeChangeSchema = z
  .object({ topic: z.string().min(1).max(200).optional(), excluded: z.boolean().optional() })
  .strict();

/** Explicit saves cannot be used as a credential store. Do not log rejected content. */
export function validateMemoryCommand(command: MemoryCommand): void {
  const content = `${command.subject} ${command.predicate} ${command.value}`;
  if (
    command.operation === 'save' &&
    /api[ _-]?key|password|credential|private[ _-]?key|access[ _-]?token|bearer\s|sk-[a-z0-9]{12}|-----BEGIN.*KEY/i.test(
      content,
    )
  )
    throw Object.assign(new Error('Credentials must use secret storage, not memory.'), {
      code: 'MEMORY_SECRET',
    });
}

export function memoryPredicateKey(value: string): string {
  return value
    .toLowerCase()
    .replace(/response[ _-]?language|language/g, 'language')
    .replace(/answer[ _-]?length/g, 'length')
    .replace(/[^\p{L}\p{N}]/gu, '');
}

export const historyPageSchema = z.object({
  episodes: z.array(topicEpisodeSchema).max(50),
  nextBefore: z.number().int().positive().nullable(),
});
export type HistoryPage = z.infer<typeof historyPageSchema>;
export const memorySelectionsResponseSchema = z.object({
  selections: z.array(personalContextEventSchema).max(20),
});
export type MemorySelectionsResponse = z.infer<typeof memorySelectionsResponseSchema>;
