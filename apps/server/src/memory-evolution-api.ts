import type { FastifyInstance } from 'fastify';
import {
  candidateDecisionSchema,
  factInvalidationSchema,
  evolutionPageQuerySchema,
  type MemoryEvolutionStorePort,
  type MemoryStorePort,
} from '@trinity-harness/contracts';
import { z } from 'zod';

export function registerMemoryEvolutionApi(
  app: FastifyInstance,
  deps: {
    evolution?: MemoryEvolutionStorePort;
    memory?: MemoryStorePort;
  },
): void {
  app.get('/api/memory/evolution', async (req, reply) => {
    if (!req.identity) return reply.code(401).send({ error: 'unauthorized' });
    if (!deps.evolution || !deps.memory) return { available: false };
    const parsed = evolutionPageQuerySchema
      .extend({ view: z.enum(['facts', 'candidates', 'playbooks']).default('facts') })
      .safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid memory query' });
    const { view, ...query } = parsed.data;
    try {
      const snapshot = await deps.memory.snapshot(req.identity);
      const revision = await deps.evolution.revision(req.identity);
      const page =
        view === 'facts'
          ? await deps.evolution.history(req.identity, query)
          : view === 'candidates'
            ? await deps.evolution.pending(req.identity, query)
            : {
                revision,
                facts: [],
                candidates: [],
                playbooks: await deps.evolution.list(req.identity, query),
                nextBefore: null,
              };
      if (
        (await deps.memory.snapshot(req.identity)).revision !== snapshot.revision ||
        (await deps.evolution.revision(req.identity)) !== revision
      )
        return reply.code(409).send({ error: 'Memory changed; refresh.' });
      return { available: true, page, policyRevision: snapshot.revision };
    } catch {
      return reply.code(503).send({ error: 'Durable memory unavailable' });
    }
  });
  app.post('/api/memory/evolution/candidates/decide', async (req, reply) => {
    if (!req.identity) return reply.code(401).send({ error: 'unauthorized' });
    if (req.identity.role === 'viewer')
      return reply.code(403).send({ error: 'Memory is read-only' });
    if (!deps.evolution) return reply.code(503).send({ error: 'Memory evolution unavailable' });
    const parsed = candidateDecisionSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid decision' });
    try {
      await deps.evolution.decide(req.identity, parsed.data);
      return { ok: true };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      return reply
        .code(code === 'MEMORY_UNAVAILABLE' ? 503 : 409)
        .send({ error: 'Memory changed or source unavailable; refresh before deciding.' });
    }
  });
  app.post('/api/memory/evolution/facts/invalidate', async (req, reply) => {
    if (!req.identity) return reply.code(401).send({ error: 'unauthorized' });
    if (req.identity.role === 'viewer')
      return reply.code(403).send({ error: 'Memory is read-only' });
    if (!deps.evolution) return reply.code(503).send({ error: 'Memory evolution unavailable' });
    const parsed = factInvalidationSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid fact change' });
    try {
      await deps.evolution.invalidate(req.identity, parsed.data);
      return { ok: true };
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      return reply
        .code(code === 'MEMORY_UNAVAILABLE' ? 503 : 409)
        .send({ error: 'Memory changed or source unavailable; refresh before editing.' });
    }
  });
}
