import type { BrowserSessionScope, SessionMetaStore } from '@trinity-harness/contracts';

/** Main anchors the personal browser; callers retain their own evidence/journals. */
export class PersonalBrowserSessionScope implements BrowserSessionScope {
  constructor(private readonly metas: Pick<SessionMetaStore, 'get' | 'getMain'>) {}

  async resolve(sessionId: string, signal?: AbortSignal): Promise<string | null> {
    signal?.throwIfAborted();
    const source = await this.metas.get(sessionId);
    if (!source?.kind || source.closedAt || source.scope === 'team') return null;
    const main = await this.metas.getMain?.(source.tenantId, source.userId);
    signal?.throwIfAborted();
    if (
      !main ||
      main.closedAt ||
      main.scope === 'team' ||
      main.kind !== 'chat' ||
      main.sessionRole !== 'main' ||
      main.userId !== source.userId ||
      main.tenantId !== source.tenantId
    )
      return null;
    return main.id;
  }
}
