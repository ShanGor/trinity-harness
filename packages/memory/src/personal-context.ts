import {
  recallResultSchema,
  type MemoryEvolutionStorePort,
  type PersonalContextPort,
  type RecallReceipt,
  type SessionMeta,
  type SessionStore,
} from '@trinity-harness/contracts';

/** No automatic fact injection: add only a durable revision fence to the baseline selection. */
export class EvolutionPersonalContext implements PersonalContextPort {
  constructor(
    private readonly baseline: PersonalContextPort,
    private readonly memory: MemoryEvolutionStorePort,
    private readonly store: SessionStore,
  ) {}
  async select(...args: Parameters<PersonalContextPort['select']>): Promise<RecallReceipt> {
    const receipt = await this.baseline.select(...args);
    if (args[0].scope !== 'personal') return receipt;
    return { ...receipt, version: 3, recallMode: 'lexical' };
  }
  observeRecall(receipt: RecallReceipt, results: readonly unknown[]): RecallReceipt {
    let next = receipt;
    for (const value of results) {
      const parsed = recallResultSchema.safeParse(value);
      if (!parsed.success) continue;
      const result = parsed.data;
      next = {
        ...next,
        ...(result.recallMode
          ? {
              recallMode:
                result.recallMode === 'hybrid' || next.recallMode === 'hybrid'
                  ? ('hybrid' as const)
                  : ('lexical' as const),
            }
          : {}),
        ...(result.evolutionRevision === undefined
          ? {}
          : { evolutionRevision: result.evolutionRevision }),
        ...(result.playbooks
          ? {
              playbooks: [
                ...new Map(
                  [...(next.playbooks ?? []), ...result.playbooks].map((book) => [
                    book.playbookId,
                    book,
                  ]),
                ).values(),
              ].slice(-50),
            }
          : {}),
        ...(result.facts
          ? {
              facts: [
                ...new Map(
                  [...(next.facts ?? []), ...result.facts].map((fact) => [fact.factId, fact]),
                ).values(),
              ].slice(-50),
            }
          : {}),
      };
    }
    return next;
  }

  async validate(meta: SessionMeta, receipt: RecallReceipt, signal?: AbortSignal): Promise<void> {
    await this.baseline.validate?.(meta, receipt, signal);
    if (meta.scope !== 'personal') return;
    const identity = { tenantId: meta.tenantId, userId: meta.userId, role: 'member' as const };
    const fail = (): never => {
      throw Object.assign(
        new Error('Personal memory changed; start a new response with current memory.'),
        { code: 'MEMORY_CONTEXT_CHANGED' },
      );
    };
    const events = await this.store.load(meta.id);
    const start = events.findIndex((e) => e.eventId === receipt.promptId);
    const end = events.findIndex((e, i) => i > start && e.type === 'message/user');
    const turn = events.slice(start + 1, end < 0 ? undefined : end);
    const calls = new Set(
      turn.flatMap((e, index) =>
        e.type === 'tool/call' &&
        e.name === 'recall' &&
        start + index + 2 > (receipt.recallAfterSeq ?? 0)
          ? [e.callId]
          : [],
      ),
    );
    const results = turn.flatMap((e) => {
      if (e.type !== 'tool/result' || e.isError || !calls.has(e.callId)) return [];
      const result = recallResultSchema.safeParse(e.value);
      return result.success ? [result.data] : [];
    });
    const facts = [
      ...new Map(
        [...(receipt.facts ?? []), ...results.flatMap((r) => r.facts ?? [])].map((fact) => [
          fact.factId,
          fact,
        ]),
      ).values(),
    ];
    const books = [
      ...new Map(
        [...(receipt.playbooks ?? []), ...results.flatMap((r) => r.playbooks ?? [])].map((book) => [
          book.playbookId,
          book,
        ]),
      ).values(),
    ];
    if (
      receipt.evolutionRevision === undefined &&
      !facts.length &&
      !books.length &&
      !results.some((r) => r.evolutionRevision !== undefined)
    )
      return;
    const revision = await this.memory.contextRevision(identity);
    if (receipt.evolutionRevision !== undefined && revision !== receipt.evolutionRevision) fail();
    for (const result of results)
      if (result.evolutionRevision !== undefined && result.evolutionRevision !== revision) fail();
    for (const fact of facts) {
      const current = await this.memory.activeFacts(identity, {
        limit: 50,
        kind: fact.kind,
        query: fact.text,
      });
      if (!current.some((f) => f.factId === fact.factId && f.revision === fact.revision)) fail();
    }
    for (const book of books) {
      const current = await this.memory.list(identity, { limit: 50, query: book.taskType });
      if (!current.some((p) => p.playbookId === book.playbookId && p.revision === book.revision))
        fail();
    }
    signal?.throwIfAborted();
  }
}
