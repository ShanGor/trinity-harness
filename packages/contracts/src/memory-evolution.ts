import { z } from 'zod';
import type { TaskBudgetScope } from './task.js';
import type { Identity } from './identity.js';
import type { HistoryQuery, HistoryPage, TopicEpisode } from './personal-assistant.js';

/** One deployment switch; individual capabilities follow configured ports. */
export const memoryEvolutionEnvShape = {
  MEMORY_EVOLUTION_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MEMORY_EMBEDDING_MODEL: z
    .string()
    .trim()
    .min(3)
    .max(300)
    .regex(/^[^/]+\/.+$/)
    .optional(),
};
export const factKindSchema = z.enum(['preference', 'profile', 'project', 'relationship', 'other']);
export type FactKind = z.infer<typeof factKindSchema>;
export const evolutionSourceSchema = z
  .object({
    sourceEpisodeId: z.uuid(),
    sourceEventId: z.uuid(),
    sourceSessionId: z.uuid(),
    sourceQuote: z
      .string()
      .trim()
      .min(1)
      .max(500)
      .refine((text) => !text.includes('\0'), 'NUL is not valid source text'),
  })
  .strict();
export const newFactSchema = z
  .object({
    kind: factKindSchema,
    text: z.string().trim().min(1).max(500),
    source: evolutionSourceSchema,
  })
  .strict();
export type NewFact = z.infer<typeof newFactSchema>;
export const memoryFactSchema = newFactSchema.extend({
  factId: z.uuid(),
  validFrom: z.iso.datetime(),
  validTo: z.iso.datetime().nullable(),
  invalidatedBy: z.uuid().optional(),
  revision: z.number().int().positive(),
});
export type MemoryFact = z.infer<typeof memoryFactSchema>;
export const revisionFenceSchema = z
  .object({
    operationId: z.uuid(),
    expectedRevision: z.number().int().nonnegative(),
    expectedPolicyRevision: z.number().int().nonnegative(),
  })
  .strict();
export type RevisionFence = z.infer<typeof revisionFenceSchema>;
export const consolidationJournalSchema = z
  .object({
    sessionId: z.uuid(),
    promptId: z.uuid(),
    callId: z.string().min(1).max(200),
  })
  .strict();
export type ConsolidationJournal = z.infer<typeof consolidationJournalSchema>;
export const playbookDraftSchema = z
  .object({
    taskType: z.string().trim().min(1).max(200),
    approach: z.string().trim().min(1).max(2000),
    pitfalls: z.array(z.string().trim().min(1).max(300)).max(10),
    sources: z.array(evolutionSourceSchema).min(1).max(5),
  })
  .strict();
export type PlaybookDraft = z.infer<typeof playbookDraftSchema>;
export const playbookSchema = playbookDraftSchema.extend({
  playbookId: z.uuid(),
  revision: z.number().int().positive(),
  at: z.iso.datetime(),
  referenceOnly: z.literal(true),
});
export type Playbook = z.infer<typeof playbookSchema>;
export const candidateDraftSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('fact'), fact: newFactSchema, replacesFactId: z.uuid().optional() })
    .strict(),
  z.object({ type: z.literal('playbook'), playbook: playbookDraftSchema }).strict(),
]);
export type CandidateDraft = z.infer<typeof candidateDraftSchema>;
export const memoryCandidateSchema = z.object({
  candidateId: z.uuid(),
  draft: candidateDraftSchema,
  journal: consolidationJournalSchema,
  status: z.enum(['pending', 'accepted', 'rejected']),
  at: z.iso.datetime(),
  decidedAt: z.iso.datetime().nullable(),
  revision: z.number().int().positive(),
  policyRevision: z.number().int().nonnegative(),
});
export type MemoryCandidate = z.infer<typeof memoryCandidateSchema>;
export const evolutionPageQuerySchema = z
  .object({
    before: z.coerce.number().int().positive().optional(),
    query: z.string().max(200).optional(),
    kind: factKindSchema.optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export type EvolutionPageQuery = z.infer<typeof evolutionPageQuerySchema>;
export const memoryEvolutionPageSchema = z.object({
  revision: z.number().int().nonnegative(),
  facts: z.array(memoryFactSchema).max(50),
  candidates: z.array(memoryCandidateSchema).max(50),
  playbooks: z.array(playbookSchema).max(50),
  nextBefore: z.number().int().positive().nullable(),
});
export type MemoryEvolutionPage = z.infer<typeof memoryEvolutionPageSchema>;
export const candidateDecisionSchema = revisionFenceSchema
  .extend({
    candidateId: z.uuid(),
    decision: z.enum(['accept', 'reject']),
  })
  .strict();
export type CandidateDecision = z.infer<typeof candidateDecisionSchema>;
export const factInvalidationSchema = revisionFenceSchema
  .extend({
    factId: z.uuid(),
    replacement: newFactSchema.optional(),
  })
  .strict();
export type FactInvalidation = z.infer<typeof factInvalidationSchema>;
export const candidateSubmissionSchema = revisionFenceSchema
  .extend({
    draft: candidateDraftSchema,
    journal: consolidationJournalSchema,
  })
  .strict();
export type CandidateSubmission = z.infer<typeof candidateSubmissionSchema>;
export const memoryProposalParametersSchema = z
  .object({
    draft: candidateDraftSchema,
    expectedRevision: z.number().int().nonnegative(),
  })
  .strict();
export interface FactStorePort {
  revision(owner: Identity): Promise<number>;
  contextRevision(owner: Identity): Promise<number>;
  activeFacts(owner: Identity, query: EvolutionPageQuery): Promise<MemoryFact[]>;
  propose(
    owner: Identity,
    fact: NewFact,
    expected: RevisionFence,
    signal?: AbortSignal,
  ): Promise<MemoryFact>;
  history(owner: Identity, query: EvolutionPageQuery): Promise<MemoryEvolutionPage>;
  invalidate(owner: Identity, command: FactInvalidation, signal?: AbortSignal): Promise<void>;
}
export interface MemoryCandidatePort {
  submit(owner: Identity, command: CandidateSubmission, signal?: AbortSignal): Promise<string>;
  decide(owner: Identity, command: CandidateDecision, signal?: AbortSignal): Promise<void>;
  pending(owner: Identity, query: EvolutionPageQuery): Promise<MemoryEvolutionPage>;
}
export interface PlaybookStorePort {
  list(owner: Identity, query: EvolutionPageQuery): Promise<Playbook[]>;
}
export interface MemoryEvolutionStorePort
  extends FactStorePort, MemoryCandidatePort, PlaybookStorePort {}

export interface EmbeddingPort {
  readonly model: string;
  embed(
    texts: string[],
    context: {
      purpose: 'memory-embedding';
      owner: Identity;
      sessionId: string;
      promptId: string;
      signal?: AbortSignal;
      taskBudget?: TaskBudgetScope;
      beforeDispatch?: () => Promise<void>;
    },
  ): Promise<{ vectors: number[][]; model: string; dimensions: number }>;
}
export interface HybridRecallPage extends HistoryPage {
  recallMode?: 'lexical' | 'hybrid';
  ranks?: { episodeId: string; source: 'vector' | 'lexical' | 'both' }[];
}
export interface SemanticRecallPort {
  searchEpisodes(
    owner: Identity,
    query: HistoryQuery,
    context: {
      sessionId: string;
      promptId: string;
      signal?: AbortSignal;
      taskBudget?: TaskBudgetScope;
    },
  ): Promise<HybridRecallPage>;
}
export interface EpisodeVectorPort {
  validate(job: EmbeddingJob, signal?: AbortSignal): Promise<void>;
  search(
    owner: Identity,
    query: HistoryQuery,
    vector: number[],
    model: string,
  ): Promise<TopicEpisode[]>;
  pending(model: string, limit: number, signal?: AbortSignal): Promise<EmbeddingJob[]>;
  complete(job: EmbeddingJob, vector: number[], model: string, signal?: AbortSignal): Promise<void>;
}
export interface EmbeddingJob {
  owner: Identity;
  episode: TopicEpisode;
  contentHash: string;
}

export const memoryEvolutionResponseSchema = z.discriminatedUnion('available', [
  z.object({ available: z.literal(false) }),
  z.object({
    available: z.literal(true),
    page: memoryEvolutionPageSchema,
    policyRevision: z.number().int().nonnegative(),
  }),
]);
export type MemoryEvolutionResponse = z.infer<typeof memoryEvolutionResponseSchema>;

const evolutionAuditBase = {
  command: z.union([
    candidateDecisionSchema,
    factInvalidationSchema,
    revisionFenceSchema.extend({ fact: newFactSchema }).strict(),
  ]),
};
export const memoryFactEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('created'), ...evolutionAuditBase, fact: memoryFactSchema }),
  z.object({
    type: z.literal('corrected'),
    ...evolutionAuditBase,
    fact: memoryFactSchema,
    retired: memoryFactSchema,
  }),
  z.object({ type: z.literal('invalidated'), ...evolutionAuditBase, retired: memoryFactSchema }),
]);
export const memoryCandidateEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('submitted'),
    command: candidateSubmissionSchema,
    candidate: memoryCandidateSchema,
  }),
  z.object({
    type: z.literal('decided'),
    command: candidateDecisionSchema,
    candidate: memoryCandidateSchema,
  }),
]);
export const memoryPlaybookEventSchema = z.object({
  type: z.literal('created'),
  command: candidateDecisionSchema,
  playbook: playbookSchema,
});
export type MemoryFactEvent = z.infer<typeof memoryFactEventSchema>;
export type MemoryCandidateEvent = z.infer<typeof memoryCandidateEventSchema>;
export type MemoryPlaybookEvent = z.infer<typeof memoryPlaybookEventSchema>;
