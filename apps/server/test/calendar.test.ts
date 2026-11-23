import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { MemorySessionStore } from '@trinity-harness/core';
import { CalendarConflict } from '@trinity-harness/db';
import {
  defaultCalendarPreferences,
  type CalendarStore,
  type Identity,
  type SessionMetaStore,
} from '@trinity-harness/contracts';
import { buildServer } from '../src/server.js';
import { usersForIdentity } from './auth-fixture.js';

describe('personal calendar HTTP boundary', () => {
  it('reports missing capability without a fake creation flow', async () => {
    const app = await buildServer({ store: new MemorySessionStore(), workspaceRoot: '/workspace' });
    try {
      const response = await app.inject({ method: 'GET', url: '/api/calendar' });
      expect(response.json()).toMatchObject({ available: false, pushAvailable: false, items: [] });
      expect(
        (await app.inject({ method: 'POST', url: '/api/calendar/items', payload: {} })).statusCode,
      ).toBe(503);
    } finally {
      await app.close();
    }
  });
  it('uses authenticated ownership, strict payloads, revision errors and read-only roles', async () => {
    let identity: Identity = { tenantId: randomUUID(), userId: randomUUID(), role: 'member' };
    const snapshot = {
      available: true,
      items: [],
      reminders: [],
      preferences: defaultCalendarPreferences,
      pushAvailable: false,
      pushPublicKey: null,
    };
    const calendar: CalendarStore = {
      snapshot: vi.fn(async () => snapshot),
      save: vi.fn(),
      preferences: vi.fn(async () => {
        throw new CalendarConflict('CALENDAR_PREFERENCES_CONFLICT');
      }),
      reminderAction: vi.fn(async () => undefined),
      subscribe: vi.fn(async () => undefined),
      tick: vi.fn(),
    };
    const app = await buildServer({
      store: new MemorySessionStore(),
      workspaceRoot: '/workspace',
      calendar,
      auth: {
        tokens: { verify: async () => identity, issue: async () => 'token' },
        users: usersForIdentity(() => identity),
        metas: {} as SessionMetaStore,
        hasher: { hash: async () => '', verify: async () => false },
      },
    });
    const headers = { authorization: 'Bearer token' };
    try {
      expect((await app.inject({ method: 'GET', url: '/api/calendar' })).statusCode).toBe(401);
      const read = await app.inject({ method: 'GET', url: '/api/calendar', headers });
      expect(read.statusCode).toBe(200);
      expect(read.headers['cache-control']).toContain('no-store');
      expect(calendar.snapshot).toHaveBeenCalledWith(identity);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/calendar/items',
            headers,
            payload: { tenantId: randomUUID() },
          })
        ).statusCode,
      ).toBe(400);
      const conflict = await app.inject({
        method: 'PUT',
        url: '/api/calendar/preferences',
        headers,
        payload: defaultCalendarPreferences,
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toEqual({ error: 'CALENDAR_PREFERENCES_CONFLICT' });
      expect(
        (
          await app.inject({
            method: 'POST',
            url: '/api/calendar/reminders/not-uuid',
            headers,
            payload: { action: 'read' },
          })
        ).statusCode,
      ).toBe(400);
      expect(
        (
          await app.inject({
            method: 'POST',
            url: `/api/calendar/reminders/${randomUUID()}`,
            headers,
            payload: { action: 'snooze' },
          })
        ).statusCode,
      ).toBe(400);
      identity = { ...identity, role: 'viewer' };
      expect(
        (
          await app.inject({
            method: 'PUT',
            url: '/api/calendar/preferences',
            headers,
            payload: defaultCalendarPreferences,
          })
        ).statusCode,
      ).toBe(403);
      expect(
        (await app.inject({ method: 'POST', url: '/api/calendar/items', headers, payload: {} }))
          .statusCode,
      ).toBe(403);
    } finally {
      await app.close();
    }
  });
});
