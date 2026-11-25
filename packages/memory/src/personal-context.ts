import {
  recallResultSchema,
  type MemoryEvolutionStorePort,
  type PersonalContextPort,
  type RecallReceipt,
  type SessionMeta,
  type SessionStore,
  type MemoryFact,
} from '@trinity-harness/contracts';
import { memoryRecallTerms } from './semantic-recall.js';

/** Bound automatic reference selection; the Loop commits the receipt before dispatch. */
export class EvolutionPersonalContext implements PersonalContextPort {
  constructor(
    private readonly baseline: PersonalContextPort,
    private readonly memory: MemoryEvolutionStorePort,
    private readonly store: SessionStore,
  ) {}
  async select(...args: Parameters<PersonalContextPort['select']>): Promise<RecallReceipt> {
    const receipt = await this.baseline.select(...args);
    if (args[0].scope !== 'personal') return receipt;
    const base: RecallReceipt = { ...receipt, version: 3, recallMode: 'lexical' };
    const [meta, , query, signal] = args;
    const terms = memoryRecallTerms(query).slice(0, 8);
    if (!terms.length) return base;
    const owner = { tenantId: meta.tenantId, userId: meta.userId, role: 'member' as const };
    try {
      const revision = await this.memory.contextRevision(owner);
      const matches = new Map<string, MemoryFact>();
      for (const term of terms) {
        signal?.throwIfAborted();
        for (const fact of await this.memory.activeFacts(owner, { query: term, limit: 10 }))
          matches.set(fact.factId, fact);
      }
      signal?.throwIfAborted();
      if ((await this.memory.contextRevision(owner)) !== revision)
        throw new Error('Memory changed during selection');
      const score = (fact: MemoryFact): number =>
        terms.filter((term) => fact.text.toLocaleLowerCase().includes(term)).length;
      const ranked = [...matches.values()]
        .filter((fact) => fact.validTo === null && score(fact) > 0)
        .sort(
          (a, b) =>
            score(b) - score(a) || b.revision - a.revision || a.factId.localeCompare(b.factId),
        );
      const injectedFacts: MemoryFact[] = [];
      for (const fact of ranked) {
        if (injectedFacts.length >= 5) break;
        if (Buffer.byteLength(JSON.stringify([...injectedFacts, fact]), 'utf8') <= 8000)
          injectedFacts.push(fact);
      }
      return injectedFacts.length
        ? {
            ...base,
            injectedFacts,
            facts: injectedFacts,
            evolutionRevision: revision,
            omitted: base.omitted || injectedFacts.length < ranked.length,
          }
        : base;
    } catch {
      signal?.throwIfAborted();
      // No archival content was delivered: capability failure can retain baseline context.
      return base;
    }
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
        [
          ...(receipt.injectedFacts ?? []),
          ...(receipt.facts ?? []),
          ...results.flatMap((r) => r.facts ?? []),
        ].map((fact) => [fact.factId, fact]),
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
        limit: 1,
        factId: fact.factId,
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
