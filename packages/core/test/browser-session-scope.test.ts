import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import type { SessionMeta } from '@trinity-harness/contracts';
import { PersonalBrowserSessionScope } from '../src/index.js';

function setup() {
  const main: SessionMeta = {
    id: randomUUID(),
    tenantId: randomUUID(),
    userId: randomUUID(),
    title: 'Main',
    workspaceUri: '/workspace/main',
    scope: 'personal',
    kind: 'chat',
    sessionRole: 'main',
    createdAt: '2026-10-26T00:00:00Z',
  };
  const side: SessionMeta = { ...main, id: randomUUID(), sessionRole: 'side' };
  const get = vi.fn(async (id: string): Promise<SessionMeta | null> =>
    id === main.id ? main : id === side.id ? side : null,
  );
  const getMain = vi.fn(async (): Promise<SessionMeta | null> => main);
  const scope = new PersonalBrowserSessionScope({ get, getMain });
  return { main, side, get, getMain, scope };
}

it('anchors Main, side chats and personal Work to the same owner Main session', async () => {
  const f = setup();
  expect(await f.scope.resolve(f.main.id)).toBe(f.main.id);
  expect(await f.scope.resolve(f.side.id)).toBe(f.main.id);
  f.side.kind = 'work';
  f.side.sessionRole = 'task';
  expect(await f.scope.resolve(f.side.id)).toBe(f.main.id);
  expect(f.getMain).toHaveBeenCalledWith(f.main.tenantId, f.main.userId);
});

it.each(['closed', 'team', 'legacy', 'missing'] as const)(
  'denies a %s source without acquiring another browser',
  async (reason) => {
    const f = setup();
    if (reason === 'closed') f.side.closedAt = '2026-10-26T00:01:00Z';
    if (reason === 'team') f.side.scope = 'team';
    if (reason === 'legacy') delete f.side.kind;
    expect(await f.scope.resolve(reason === 'missing' ? randomUUID() : f.side.id)).toBeNull();
    expect(f.getMain).not.toHaveBeenCalled();
  },
);

it.each(['other user', 'other tenant', 'closed', 'team', 'side', 'work', 'missing'] as const)(
  'fails closed on a %s Main mapping',
  async (reason) => {
    const f = setup();
    const changed = { ...f.main };
    if (reason === 'other user') changed.userId = randomUUID();
    if (reason === 'other tenant') changed.tenantId = randomUUID();
    if (reason === 'closed') changed.closedAt = '2026-10-26T00:01:00Z';
    if (reason === 'team') changed.scope = 'team';
    if (reason === 'side') changed.sessionRole = 'side';
    if (reason === 'work') changed.kind = 'work';
    f.getMain.mockResolvedValueOnce(reason === 'missing' ? null : changed);
    expect(await f.scope.resolve(f.side.id)).toBeNull();
  },
);

it('does not cache ownership and propagates cancellation and lookup failure', async () => {
  const f = setup();
  expect(await f.scope.resolve(f.side.id)).toBe(f.main.id);
  f.side.closedAt = '2026-10-26T00:01:00Z';
  expect(await f.scope.resolve(f.side.id)).toBeNull();
  f.get.mockRejectedValueOnce(new Error('metadata unavailable'));
  await expect(f.scope.resolve(f.main.id)).rejects.toThrow('metadata unavailable');
  await expect(f.scope.resolve(f.main.id, AbortSignal.abort())).rejects.toThrow();
});
