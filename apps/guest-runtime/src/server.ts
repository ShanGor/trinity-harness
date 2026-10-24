import Fastify, { type FastifyInstance } from 'fastify';
import {
  GUEST_WIRE_BYTES,
  guestEnvelopeSchema,
  guestResponseSchema,
} from '@trinity-harness/contracts';
import type { GuestRuntime } from './runtime.js';

/** Listen only on a protected Unix socket behind the guest vsock bridge. */
export function buildGuestServer(runtime: Pick<GuestRuntime, 'execute'>): FastifyInstance {
  const app = Fastify({ logger: false, bodyLimit: GUEST_WIRE_BYTES, requestTimeout: 130_000 });
  app.post('/rpc', async (request, reply) => {
    const parsed = guestEnvelopeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid guest request' });
    const cancelled = new AbortController();
    const abort = (): void => {
      if (!reply.raw.writableFinished) cancelled.abort();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    try {
      const value = await runtime.execute(parsed.data, cancelled.signal);
      const response = guestResponseSchema.parse({
        requestId: parsed.data.requestId,
        generation: parsed.data.generation,
        value,
      });
      if (Buffer.byteLength(JSON.stringify(response)) > GUEST_WIRE_BYTES)
        throw new Error('Guest response overflow');
      return response;
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abort);
    }
  });
  app.setErrorHandler((_error, _request, reply) =>
    reply.code(503).send({ error: 'guest operation unavailable; effect may be unknown' }),
  );
  return app;
}
