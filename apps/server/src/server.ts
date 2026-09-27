import type { AgentLoop, EventSink, LoopEvent, SessionStore } from '@trinity-harness/contracts';
import { serverEventSchema } from '@trinity-harness/shared';
import type { ServerEvent } from '@trinity-harness/shared';
import Fastify from 'fastify';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/** Inbound payload validation at the HTTP boundary (AGENTS.md §5). */
const createSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

const postMessageSchema = z.object({
  text: z.string().min(1).max(100_000),
});

const postParamsSchema = z.object({
  sessionId: z.uuid(),
});

function preview(value: unknown, max = 2000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** LoopEvent → ACP-flavored wire events (docs/design.md §11.4). */
export function toServerEvent(sessionId: string, event: LoopEvent): ServerEvent | null {
  switch (event.type) {
    case 'text-delta':
      return {
        type: 'session/update',
        sessionId,
        update: { kind: 'agent_message_chunk', text: event.text },
      };
    case 'message/assistant':
      return {
        type: 'message/committed',
        sessionId,
        message: { role: 'assistant', content: event.content },
      };
    case 'tool/call':
      return {
        type: 'session/update',
        sessionId,
        update: {
          kind: 'tool_call',
          toolCallId: event.call.id,
          title: `${event.call.name}(${preview(event.call.args, 120)})`,
          status: 'in_progress',
        },
      };
    case 'tool/result':
      return {
        type: 'session/update',
        sessionId,
        update: {
          kind: 'tool_call',
          toolCallId: event.callId,
          title: '',
          status: event.result.isError ? 'failed' : 'completed',
          content: preview(event.result.value),
        },
      };
    case 'turn/end':
      if (event.reason === 'error') {
        return { type: 'error', sessionId, message: event.detail ?? 'turn failed' };
      }
      return null;
    default:
      return null;
  }
}

export interface ServerDeps {
  store: SessionStore;
  /** Loop factory; the run-time sink is passed to run() instead. */
  createLoop: (sessionId: string) => AgentLoop;
  workspaceRoot: string;
}

export interface BuildServerOptions {
  logger?: boolean;
}

/**
 * HTTP + SSE surface for the M1 minimal loop (composition root input is fully
 * injected, so tests drive it with fake LLM/sandbox).
 */
export async function buildServer(
  deps: ServerDeps,
  opts?: BuildServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts?.logger ?? false });
  const subscribers = new Map<string, Set<(event: ServerEvent) => void>>();

  const broadcast = (sessionId: string, event: ServerEvent): void => {
    for (const listener of subscribers.get(sessionId) ?? []) {
      try {
        listener(event);
      } catch {
        // A dead listener must not break broadcasting; cleanup happens on close.
      }
    }
  };

  const sinkFor = (sessionId: string): EventSink => ({
    emit: (loopEvent) => {
      const wire = toServerEvent(sessionId, loopEvent);
      if (wire) {
        broadcast(sessionId, serverEventSchema.parse(wire));
      }
    },
  });

  app.get('/api/health', async () => ({ ok: true }));

  app.post('/api/sessions', async (req, reply) => {
    const body = createSessionSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
    }
    const sessionId = crypto.randomUUID();
    await deps.store.append(sessionId, [
      {
        type: 'session/created',
        eventId: crypto.randomUUID(),
        at: new Date().toISOString(),
        workspaceUri: deps.workspaceRoot,
      },
    ]);
    return reply.code(201).send({ sessionId });
  });

  app.get('/api/sessions/:sessionId/messages', async (req, reply) => {
    const params = postParamsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid session id' });
    }
    const surface = await deps.store.projectMessages(params.data.sessionId);
    return {
      messages: surface.map((m) => ({
        role: m.role,
        content: m.content
          .map((b) => (b.kind === 'text' ? b.text : `[${b.kind}: ${b.uri}]`))
          .join('\n'),
      })),
    };
  });

  app.post('/api/sessions/:sessionId/messages', async (req, reply) => {
    const params = postParamsSchema.safeParse(req.params);
    const body = postMessageSchema.safeParse(req.body);
    if (!params.success || !body.success) {
      return reply.code(400).send({ error: 'invalid request' });
    }
    const sessionId = params.data.sessionId;
    const sink = sinkFor(sessionId);
    const loop = deps.createLoop(sessionId);
    // Run detached: SSE subscribers observe progress; failures surface as events.
    void loop.run(sessionId, body.data.text, sink).catch((err: unknown) => {
      broadcast(sessionId, {
        type: 'error',
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    });
    return reply.code(202).send({ accepted: true });
  });

  app.get('/api/sessions/:sessionId/events', async (req, reply) => {
    const params = postParamsSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: 'invalid session id' });
    }
    const sessionId = params.data.sessionId;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // SSE through proxies: disable buffering (docs/design.md §16).
      'x-accel-buffering': 'no',
    });

    const send = (event: ServerEvent): void => {
      // M1: a single unnamed event stream. Seq-based `id:` fields and resume
      // replay land with the ACP HTTP binding in M3 (docs/design.md §11.3).
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    send({ type: 'session/update', sessionId, update: { kind: 'agent_thought_chunk', text: '' } });

    const listeners = subscribers.get(sessionId) ?? new Set();
    listeners.add(send);
    subscribers.set(sessionId, listeners);

    // Heartbeat so clients can distinguish "idle" from "dead" (design.md §11.3).
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      subscribers.get(sessionId)?.delete(send);
      reply.raw.end();
    };
    req.raw.on('close', cleanup);

    await new Promise<void>((resolve) => {
      reply.raw.on('close', resolve);
    });
  });

  await app.ready();
  return app;
}
