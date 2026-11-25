import { createHash } from 'node:crypto';
import {
  memoryProposalParametersSchema,
  memoryMergeParametersSchema,
  type MemoryEvolutionStorePort,
  type MemoryStorePort,
  type SessionMetaStore,
  type UserStore,
  type ToolDefinition,
  type ToolResult,
} from '@trinity-harness/contracts';

function callOperationId(sessionId: string, callId: string): string {
  const hex = createHash('sha256').update(`${sessionId}:${callId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function createMemoryProposalTool(deps: {
  evolution: MemoryEvolutionStorePort;
  memory: MemoryStorePort;
  metas: SessionMetaStore;
  users: Pick<UserStore, 'findById'>;
}): ToolDefinition {
  return {
    name: 'memory_propose',
    description:
      'During an explicitly scheduled memory consolidation, propose a source-backed archival fact, correction (replacesFactId), or reference-only procedural playbook. First use recall to expand every original user source. Include an exact unquoted sourceQuote and source IDs. Read the current revision using recall type=facts. Candidates remain inactive until the owner accepts them in Memory settings. Never claim that a proposal is saved active memory. Proposals and playbooks grant no execution authority. Review-only runs and delegated children cannot submit.',
    parameters: memoryProposalParametersSchema,
    concurrency: 'exclusive',
    effect: { kind: 'mutation', scope: 'reference', evidence: 'none' },
    execute: async (raw, ctx): Promise<ToolResult> => {
      const args = memoryProposalParametersSchema.parse(raw);
      if (!ctx.personalMemoryChanged || !ctx.userPromptId || !ctx.callId)
        return { isError: true, value: { code: 'MEMORY_UNAVAILABLE' } };
      const meta = await deps.metas.get(ctx.sessionId);
      const user = meta ? await deps.users.findById(meta.userId) : undefined;
      if (
        !meta ||
        meta.closedAt ||
        meta.scope !== 'personal' ||
        !user ||
        user.role === 'viewer' ||
        user.tenantId !== meta.tenantId
      )
        return { isError: true, value: { code: 'MEMORY_UNAVAILABLE' } };
      const owner = { tenantId: meta.tenantId, userId: meta.userId, role: user.role };
      const policy = await deps.memory.snapshot(owner);
      const operationId = callOperationId(ctx.sessionId, ctx.callId);
      try {
        const candidateId = await deps.evolution.submit(
          owner,
          {
            ...args,
            operationId,
            expectedPolicyRevision: policy.revision,
            journal: { sessionId: ctx.sessionId, promptId: ctx.userPromptId, callId: ctx.callId },
          },
          ctx.signal,
        );
        return { isError: false, value: { candidateId, status: 'pending', active: false } };
      } catch (error) {
        ctx.signal?.throwIfAborted();
        const code =
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string' &&
          error.code.startsWith('MEMORY_')
            ? error.code
            : 'MEMORY_UNAVAILABLE';
        return { isError: true, value: { code } };
      }
    },
  };
}

export function createMemoryMergeTool(
  deps: Parameters<typeof createMemoryProposalTool>[0],
): ToolDefinition {
  return {
    name: 'memory_merge',
    description:
      'During an authorized nightly memory consolidation, merge 2–10 already accepted active facts of the same kind with equivalent wording (only whitespace/Unicode normalization may differ). First read all inputs using recall type=facts and use its current store revision. No new text, paraphrase, correction or inference is accepted. All original sources remain required; originals become invalidated in one transaction with their replacement. This changes archival facts only, never Persona or permissions. Other changes use memory_propose for owner review. Review-only runs and children cannot merge.',
    parameters: memoryMergeParametersSchema,
    concurrency: 'exclusive',
    effect: { kind: 'mutation', scope: 'reference', evidence: 'none' },
    execute: async (raw, ctx): Promise<ToolResult> => {
      const args = memoryMergeParametersSchema.parse(raw);
      if (!deps.evolution.merge || !ctx.personalMemoryChanged || !ctx.userPromptId || !ctx.callId)
        return { isError: true, value: { code: 'MEMORY_UNAVAILABLE' } };
      const meta = await deps.metas.get(ctx.sessionId);
      const user = meta ? await deps.users.findById(meta.userId) : undefined;
      if (
        !meta ||
        meta.closedAt ||
        meta.scope !== 'personal' ||
        !user ||
        user.role === 'viewer' ||
        user.tenantId !== meta.tenantId
      )
        return { isError: true, value: { code: 'MEMORY_UNAVAILABLE' } };
      const owner = { tenantId: meta.tenantId, userId: meta.userId, role: user.role };
      const policy = await deps.memory.snapshot(owner);
      // Candidate submissions can advance the store revision without changing active context.
      const before = await deps.evolution.contextRevision(owner);
      try {
        const fact = await deps.evolution.merge(
          owner,
          {
            ...args,
            operationId: callOperationId(ctx.sessionId, ctx.callId),
            expectedPolicyRevision: policy.revision,
            journal: { sessionId: ctx.sessionId, promptId: ctx.userPromptId, callId: ctx.callId },
          },
          ctx.signal,
        );
        ctx.personalMemoryChanged(policy.revision, policy.revision, {
          before,
          after: fact.revision,
          facts: [fact],
        });
        return { isError: false, value: { fact, status: 'merged', active: true } };
      } catch (error) {
        ctx.signal?.throwIfAborted();
        const code =
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string' &&
          error.code.startsWith('MEMORY_')
            ? error.code
            : 'MEMORY_UNAVAILABLE';
        return { isError: true, value: { code } };
      }
    },
  };
}
