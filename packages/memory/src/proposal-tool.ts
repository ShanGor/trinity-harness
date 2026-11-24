import { createHash } from 'node:crypto';
import {
  memoryProposalParametersSchema,
  type MemoryEvolutionStorePort,
  type MemoryStorePort,
  type SessionMetaStore,
  type UserStore,
  type ToolDefinition,
  type ToolResult,
} from '@trinity-harness/contracts';

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
      const hex = createHash('sha256').update(`${ctx.sessionId}:${ctx.callId}`).digest('hex');
      const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
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
