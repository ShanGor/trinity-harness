import { timingSafeEqual } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  browserRuntimeRequestSchema,
  browserPreviewRequestSchema,
  browserPreviewSchema,
  type BrowserRuntimePort,
  type BrowserPreviewPort,
  browserInteractionRequestSchema,
  browserInteractionResultSchema,
  type BrowserInteractionPort,
} from '@trinity-harness/contracts';

export function buildBrowserRuntimeServer(
  runtime: BrowserRuntimePort & Partial<BrowserPreviewPort & BrowserInteractionPort>,
  token: string,
): FastifyInstance {
  if (token.length < 32) throw new Error('BROWSER_RUNTIME_TOKEN must have at least 32 characters');
  const expected = Buffer.from(`Bearer ${token}`);
  const app = Fastify({ logger: false, bodyLimit: 24 * 1024, requestTimeout: 120_000 });
  app.addHook('onRequest', async (request, reply) => {
    const actual = Buffer.from(request.headers.authorization ?? '');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      return reply.code(401).send({ error: 'unauthorized' });
  });
  app.post('/execute', async (request, reply) => {
    const parsed = browserRuntimeRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid browser request' });
    const cancelled = new AbortController();
    const abort = (): void => {
      if (!reply.raw.writableFinished) cancelled.abort();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    try {
      return await runtime.execute(parsed.data, cancelled.signal);
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abort);
    }
  });
  app.setErrorHandler((error, _request, reply) => {
    const status =
      error instanceof Error &&
      'statusCode' in error &&
      (error.statusCode === 400 || error.statusCode === 413)
        ? error.statusCode
        : 500;
    return reply.code(status).send({ error: 'browser runtime unavailable' });
  });
  app.post('/preview', async (request, reply) => {
    const parsed = browserPreviewRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid preview request' });
    const cancelled = new AbortController();
    const abort = (): void => {
      if (!reply.raw.writableFinished) cancelled.abort();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    try {
      return reply.header('cache-control', 'private, no-store').send(
        browserPreviewSchema.parse(
          (await runtime.preview?.(parsed.data.sessionId, cancelled.signal)) ?? {
            state: 'unavailable',
          },
        ),
      );
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abort);
    }
  });
  app.post('/interaction', async (request, reply) => {
    const parsed = browserInteractionRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid browser interaction' });
    if (!runtime.interact)
      return reply.code(503).send({ error: 'browser interaction unavailable' });
    const cancelled = new AbortController();
    const abort = (): void => {
      if (!reply.raw.writableFinished) cancelled.abort();
    };
    request.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    try {
      return reply
        .header('cache-control', 'private, no-store')
        .send(
          browserInteractionResultSchema.parse(
            await runtime.interact(parsed.data, cancelled.signal),
          ),
        );
    } finally {
      request.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abort);
    }
  });
  return app;
}
