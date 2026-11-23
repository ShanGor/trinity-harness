import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  calendarSaveSchema,
  calendarPreferencesSchema,
  calendarReminderActionSchema,
  calendarPushSubscriptionSchema,
  calendarSnapshotSchema,
  defaultCalendarPreferences,
  type CalendarStore,
} from '@trinity-harness/contracts';

/** Calendar routes are authenticated by the same global hook as other owner APIs. */
export function registerCalendarApi(app: FastifyInstance, calendar?: CalendarStore): void {
  const handle = async (reply: FastifyReply, action: () => Promise<unknown>): Promise<unknown> => {
    reply.header('cache-control', 'private, no-store');
    try {
      return await action();
    } catch (error) {
      const coded = z.object({ code: z.string().regex(/^CALENDAR_[A-Z_]+$/) }).safeParse(error);
      if (!coded.success) throw error;
      return reply
        .code(coded.data.code === 'CALENDAR_FORBIDDEN' ? 403 : 409)
        .send({ error: coded.data.code });
    }
  };
  app.get('/api/calendar', async (req, reply) =>
    handle(reply, async () =>
      calendarSnapshotSchema.parse(
        calendar && req.identity
          ? await calendar.snapshot(req.identity)
          : {
              available: false,
              items: [],
              reminders: [],
              preferences: defaultCalendarPreferences,
              pushAvailable: false,
              pushPublicKey: null,
            },
      ),
    ),
  );
  app.post('/api/calendar/items', async (req, reply) => {
    if (!calendar || !req.identity) return reply.code(503).send({ error: 'calendar unavailable' });
    if (req.identity.role === 'viewer') return reply.code(403).send({ error: 'read-only role' });
    const input = calendarSaveSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid calendar item' });
    return handle(reply, () => calendar.save(req.identity!, input.data, new Date()));
  });
  app.put('/api/calendar/preferences', async (req, reply) => {
    if (!calendar || !req.identity) return reply.code(503).send({ error: 'calendar unavailable' });
    if (req.identity.role === 'viewer') return reply.code(403).send({ error: 'read-only role' });
    const input = calendarPreferencesSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid calendar preferences' });
    return handle(reply, () => calendar.preferences(req.identity!, input.data));
  });
  app.post('/api/calendar/reminders/:id', async (req, reply) => {
    if (!calendar || !req.identity) return reply.code(503).send({ error: 'calendar unavailable' });
    if (req.identity.role === 'viewer') return reply.code(403).send({ error: 'read-only role' });
    const params = z.object({ id: z.uuid() }).safeParse(req.params);
    const input = calendarReminderActionSchema.safeParse(req.body);
    if (!params.success || !input.success)
      return reply.code(400).send({ error: 'invalid calendar reminder action' });
    return handle(reply, async () => {
      await calendar.reminderAction(req.identity!, params.data.id, input.data, new Date());
      return { ok: true };
    });
  });
  app.put('/api/calendar/push', async (req, reply) => {
    if (!calendar || !req.identity) return reply.code(503).send({ error: 'calendar unavailable' });
    if (req.identity.role === 'viewer') return reply.code(403).send({ error: 'read-only role' });
    const input = calendarPushSubscriptionSchema.nullable().safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid push subscription' });
    return handle(reply, async () => {
      await calendar.subscribe(req.identity!, input.data);
      return { ok: true };
    });
  });
}
