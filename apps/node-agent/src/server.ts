import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  nodeRuntimeRequestSchema,
  environmentRecordSchema,
  guestEnvelopeSchema,
  guestResponseSchema,
  GUEST_WIRE_BYTES,
  type GuestRelayPort,
  type SessionMetaStore,
  type UserStore,
  type EnvironmentRecord,
  type GuestEnvelope,
  nodeRuntimeResultSchema,
  type EnvironmentStore,
  type NodeRuntimePort,
} from '@trinity-harness/contracts';

export function buildNodeAgent(
  runtime: NodeRuntimePort,
  store: Pick<EnvironmentStore, 'authorizeNode'>,
  nodeId: string,
  token: string,
  guest?: {
    relay: GuestRelayPort;
    metas: Pick<SessionMetaStore, 'get'>;
    users: Pick<UserStore, 'findById'>;
    workspaceRoot: string;
  },
): FastifyInstance {
  if (token.length < 32) throw new Error('Node token too short');
  const expected = Buffer.from(`Bearer ${token}`);
  const app = Fastify({ logger: false, bodyLimit: GUEST_WIRE_BYTES });
  app.addHook('onRequest', async (request, reply) => {
    const actual = Buffer.from(request.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return reply.code(401).send({ error: 'unauthorized' });
  });
  app.post('/instances', { bodyLimit: 4096 }, async (request, reply) => {
    const parsed = nodeRuntimeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid instance request' });
    const { operation, environment } = parsed.data;
    if (operation === 'start' && !['starting', 'running'].includes(environment.state))
      return reply.code(409).send({ error: 'a current capacity reservation is required' });
    if (environment.nodeId !== nodeId || !(await store.authorizeNode(environment)))
      return reply.code(409).send({ error: 'stale or unassigned instance' });
    const cancel = new AbortController();
    const abort = (): void => {
      if (!reply.raw.writableFinished) cancel.abort();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    try {
      const result = await runtime.command(operation, environment, cancel.signal);
      if (!(await store.authorizeNode(environment)))
        return reply.code(409).send({ error: 'instance generation changed' });
      return nodeRuntimeResultSchema.parse(result);
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abort);
    }
  });
  app.post('/guest', async (request, reply) => {
    if (!guest) return reply.code(503).send({ error: 'guest routing is disabled' });
    const parsed = z
      .object({ environment: environmentRecordSchema, request: guestEnvelopeSchema })
      .strict()
      .safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid guest envelope' });
    const { environment, request: envelope } = parsed.data;
    const authorized = async (env: EnvironmentRecord, rpc: GuestEnvelope): Promise<boolean> => {
      if (
        env.nodeId !== nodeId ||
        env.state !== 'running' ||
        env.id !== rpc.environmentId ||
        env.generation !== rpc.generation ||
        !(await store.authorizeNode(env))
      )
        return false;
      const meta = await guest.metas.get(rpc.sessionId);
      const user = meta ? await guest.users.findById(meta.userId) : null;
      return !!(
        meta?.workspaceUri &&
        meta.kind &&
        !meta.closedAt &&
        meta.scope !== 'team' &&
        meta.tenantId === env.tenantId &&
        meta.userId === env.userId &&
        user &&
        user.tenantId === env.tenantId &&
        user.role !== 'viewer' &&
        path.relative(path.resolve(guest.workspaceRoot), path.resolve(meta.workspaceUri)) ===
          rpc.workspace
      );
    };
    if (!(await authorized(environment, envelope)))
      return reply.code(409).send({ error: 'guest assignment or session access changed' });
    const cancelled = new AbortController();
    const abort = (): void => {
      if (!reply.raw.writableFinished) cancelled.abort();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    try {
      const value = await guest.relay.call(environment, envelope, cancelled.signal);
      if (!(await authorized(environment, envelope)))
        return reply
          .code(409)
          .send({ error: 'guest assignment or session access changed; effect may be unknown' });
      return guestResponseSchema.parse({
        requestId: envelope.requestId,
        generation: envelope.generation,
        value,
      });
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abort);
    }
  });
  app.setErrorHandler((_error, _req, reply) =>
    reply.code(503).send({ error: 'node operation unavailable' }),
  );
  return app;
}
