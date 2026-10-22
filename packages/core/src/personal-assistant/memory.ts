import { createHash } from 'node:crypto';
import type {
  ConversationIndexPort,
  Identity,
  MemoryCommand,
  MemoryStorePort,
  PersonalContextPort,
  RecallReceipt,
  SessionMeta,
  SavedMemory,
  SessionStore,
} from '@trinity-harness/contracts';

import {
  validateMemoryCommand,
  turnMessageProjection,
  recallResultSchema,
  memoryPredicateKey as predicateKey,
} from '@trinity-harness/contracts';
export { validateMemoryCommand } from '@trinity-harness/contracts';

type ExplicitChange = { predicate: string; value?: string; forget?: boolean };

/** Deliberately narrow grammar: quoted documents and inferred preferences never write memory. */
export function explicitMemoryChanges(text: string): ExplicitChange[] {
  const remember = /^remember:\s*([^\n]{1,3000})$/iu.exec(text.trim());
  if (remember) {
    const clauses = remember[1]!
      .replace(/[.!]$/, '')
      .replace(/ from now on$/iu, '')
      .split(/\s+and\s+(?=keep|reply|respond|answer)/iu);
    const changes: ExplicitChange[] = [];
    for (const clause of clauses) {
      const language = /^(?:reply|respond|answer) in ([\p{L} -]{2,50})$/iu.exec(clause);
      if (language) {
        changes.push({ predicate: 'response_language', value: language[1]!.trim() });
        continue;
      }
      if (/^keep (?:your )?answers? concise$/iu.test(clause)) {
        changes.push({ predicate: 'answer_length', value: 'concise' });
        continue;
      }
      const fact = /^([^:\n]{1,100}):\s*(.{1,2000})$/u.exec(clause);
      if (fact) {
        changes.push({ predicate: fact[1]!.trim(), value: fact[2]!.trim() });
        continue;
      }
      return [];
    }
    return new Set(changes.map((change) => predicateKey(change.predicate))).size === changes.length
      ? changes
      : [];
  }
  const forget = /^forget my (.{1,100}?)(?: preference)?[.!]?$/iu.exec(text.trim());
  if (forget) return [{ predicate: forget[1]!, forget: true }];
  const correct = /^change my (.{1,100}?) (?:preference )?to (.{1,2000})[.!]?$/iu.exec(text.trim());
  return correct ? [{ predicate: correct[1]!, value: correct[2]!.replace(/[.!]$/, '') }] : [];
}

function stableId(value: string): string {
  const hex = createHash('sha256').update(value).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export class PersonalContext implements PersonalContextPort {
  constructor(
    private readonly memory: MemoryStorePort,
    private readonly index: ConversationIndexPort,
    private readonly store?: SessionStore,
  ) {}
  async validate(meta: SessionMeta, receipt: RecallReceipt, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const identity: Identity = { tenantId: meta.tenantId, userId: meta.userId, role: 'developer' };
    const snapshot = await this.memory.snapshot(identity);
    const fail = (): never => {
      throw Object.assign(
        new Error(
          'Memory or recall permissions changed during this response. Send a follow-up to use the updated context.',
        ),
        { code: 'MEMORY_CONTEXT_CHANGED' },
      );
    };
    if (snapshot.revision !== receipt.policyRevision) fail();
    for (const episode of receipt.episodes) {
      const current = await this.index.evidence?.(identity, episode.episodeId);
      if (!current || current.excluded) fail();
    }
    for (const turn of receipt.interruptedTurns ?? []) {
      const current = await this.index.evidence?.(identity, turn.promptId);
      if (current?.excluded) fail();
    }
    for (const exchange of receipt.dialogue ?? []) {
      const current = await this.index.evidence?.(identity, exchange.promptId);
      if (
        current?.excluded ||
        (snapshot.hasSuppression && (!current || current.policyRevision < snapshot.revision))
      )
        fail();
    }
    if (this.store) {
      const events = await this.store.load(meta.id);
      const start = events.findIndex((event) => event.eventId === receipt.promptId);
      if (start < 0) fail();
      const end = events.findIndex((event, i) => i > start && event.type === 'message/user');
      const turn = events.slice(start + 1, end < 0 ? undefined : end);
      const recallCalls = new Set(
        turn.flatMap((event) =>
          event.type === 'tool/call' && event.name === 'recall' ? [event.callId] : [],
        ),
      );
      for (const event of turn) {
        if (event.type !== 'tool/result' || event.isError || !recallCalls.has(event.callId))
          continue;
        const parsed = recallResultSchema.safeParse(event.value);
        if (!parsed.success || parsed.data.policyRevision !== snapshot.revision) fail();
        if (!parsed.success) continue;
        for (const source of parsed.data.episodes ?? []) {
          const current = await this.index.evidence?.(identity, source.episodeId);
          if (
            !current ||
            current.excluded ||
            (snapshot.hasSuppression && current.policyRevision < snapshot.revision)
          )
            fail();
        }
        if (parsed.data.episodeId) {
          const current = await this.index.evidence?.(identity, parsed.data.episodeId);
          if (
            !current ||
            current.excluded ||
            (snapshot.hasSuppression && current.policyRevision < snapshot.revision)
          )
            fail();
        }
        for (const source of parsed.data.sources ?? []) {
          if (source.sessionId !== meta.id) continue; // Cross-session expansion is fenced by episodeId above.
          const user = events.slice(0, source.seq).findLast((item) => item.type === 'message/user');
          const current = user ? await this.index.evidence?.(identity, user.eventId) : null;
          if (
            current?.excluded ||
            (snapshot.hasSuppression && (!current || current.policyRevision < snapshot.revision))
          )
            fail();
        }
      }
    }
    signal?.throwIfAborted();
  }
  async select(
    meta: SessionMeta,
    promptId: string,
    query: string,
    signal?: AbortSignal,
    sourceAt?: string,
    dialogueCharacters = 32_000,
  ): Promise<RecallReceipt> {
    signal?.throwIfAborted();
    // Team execution receives no personal profile or personal history.
    if (meta.scope === 'team')
      return { promptId, policyRevision: 0, memories: [], episodes: [], omitted: false };
    const identity: Identity = { tenantId: meta.tenantId, userId: meta.userId, role: 'developer' };
    let snapshot = await this.memory.snapshot(identity);
    const explicit = explicitMemoryChanges(query);
    let commandResult: string | undefined =
      !explicit.length && /^(remember:|forget my |change my )/iu.test(query.trim())
        ? 'No memory change was made. Ask the user to save or select the item in Memory settings.'
        : undefined;
    if (explicit.length) {
      const results: SavedMemory[] = [];
      const commands: MemoryCommand[] = [];
      for (const change of explicit) {
        signal?.throwIfAborted();
        const matches = snapshot.items.filter(
          (item) =>
            item.subject === 'Me' &&
            predicateKey(item.predicate) === predicateKey(change.predicate),
        );
        const current =
          matches.find((item) => item.status === 'active') ??
          (change.forget ? matches[0] : undefined);
        if (
          matches.filter((item) => item.status === 'active').length > 1 ||
          (change.forget && !current)
        ) {
          commandResult =
            'No unambiguous saved preference matched. Ask the user to select the item in Memory settings.';
          break;
        }
        if (change.forget && current?.status === 'forgotten') {
          results.push(current);
          continue;
        }
        const command: MemoryCommand = {
          operationId: stableId(`${meta.tenantId}:${meta.userId}:${promptId}:${change.predicate}`),
          memoryId:
            current?.memoryId ??
            stableId(`${meta.tenantId}:${meta.userId}:${promptId}:memory:${change.predicate}`),
          expectedRevision: current?.revision ?? 0,
          operation: change.forget ? 'forget' : 'save',
          subject: 'Me',
          predicate: current?.predicate ?? change.predicate,
          value: change.value ?? current!.value,
          source: {
            sessionId: meta.id,
            eventId: promptId,
            excerpt: query.slice(0, 3000),
            ...(sourceAt ? { at: sourceAt } : {}),
          },
        };
        validateMemoryCommand(command);
        commands.push(command);
      }
      if (!commandResult) {
        if (this.memory.changeMany)
          results.push(...(await this.memory.changeMany(identity, commands)));
        else
          for (const command of commands) results.push(await this.memory.change(identity, command));
        snapshot = await this.memory.snapshot(identity);
      }
      commandResult ??= `Persisted explicit memory command: ${results.map((item) => `${item.predicate} ${item.status === 'forgotten' ? 'forgotten' : 'saved'}`).join(', ')}. Original conversation history is retained.`;
    }
    signal?.throwIfAborted();
    const memories = snapshot.items.filter((item) => item.status === 'active').slice(0, 40);
    // History expansion is model-directed through recall. Recency alone does not
    // make another session's outcome relevant to the current request.
    const episodes: RecallReceipt['episodes'] = [];
    const dialogue: NonNullable<RecallReceipt['dialogue']> = [];
    let remaining = Math.max(0, Math.min(64_000, dialogueCharacters));
    let dialogueOmitted = false;
    if (this.store) {
      const events = await this.store.load(meta.id);
      const current = events.findIndex((event) => event.eventId === promptId);
      const { finals } = turnMessageProjection(events);
      const starts = events.flatMap((event, i) =>
        event.type === 'message/user' && i < current ? [i] : [],
      );
      const text = (
        event: Extract<(typeof events)[number], { type: 'message/user' | 'message/assistant' }>,
      ): string =>
        event.content
          .filter((block) => block.kind === 'text')
          .map((block) => block.text)
          .join('\n');
      const excerpt = (
        event: (typeof events)[number],
        seq: number,
        value: string,
        limit: number,
      ): NonNullable<RecallReceipt['dialogue']>[number]['request'] => {
        const to = Math.min(value.length, Math.max(0, limit));
        return {
          eventId: event.eventId,
          seq,
          from: 0,
          to,
          totalCharacters: value.length,
          text: value.slice(0, to),
        };
      };
      for (const start of starts.reverse()) {
        signal?.throwIfAborted();
        const user = events[start];
        if (user?.type !== 'message/user') continue;
        const end = events.findIndex((event, i) => i > start && event.type === 'message/user');
        const span = events.slice(start + 1, end < 0 ? current : end);
        if (
          !span.some(
            (event) =>
              event.type === 'turn/end' &&
              event.reason === 'completed' &&
              (!event.promptId || event.promptId === user.eventId),
          )
        )
          continue;
        const indexed = await this.index.evidence?.(identity, user.eventId);
        if (
          indexed?.excluded ||
          (snapshot.hasSuppression && (!indexed || indexed.policyRevision < snapshot.revision))
        )
          continue;
        const answerIndex = events.findLastIndex(
          (event, i) =>
            i > start &&
            i < (end < 0 ? current : end) &&
            finals.has(i) &&
            event.type === 'message/assistant',
        );
        const answer = events[answerIndex];
        if (answer?.type !== 'message/assistant') continue;
        if (dialogue.length >= 6 || remaining < 256) {
          dialogueOmitted = true;
          break;
        }
        const requestText = text(user);
        const answerText = text(answer);
        const request = excerpt(
          user,
          start + 1,
          requestText,
          Math.min(2000, Math.floor(remaining / 4)),
        );
        const attachments = user.content.flatMap((block) => {
          if (block.kind !== 'image' && block.kind !== 'file') return [];
          const source = events.findLast(
            (event) => event.type === 'session/attachment' && event.uri === block.uri,
          );
          return [
            {
              kind: block.kind,
              uri: block.uri,
              ...(block.mimeType ? { mimeType: block.mimeType } : {}),
              ...(source?.type === 'session/attachment'
                ? { workspacePath: source.workspacePath }
                : {}),
            },
          ];
        });
        if (attachments.length) request.attachments = attachments.slice(0, 32);
        dialogueOmitted ||= attachments.length > 32;
        const response = excerpt(
          answer,
          answerIndex + 1,
          answerText,
          remaining - request.text.length,
        );
        dialogueOmitted ||=
          request.to < request.totalCharacters || response.to < response.totalCharacters;
        remaining -= request.text.length + response.text.length;
        dialogue.unshift({ promptId: user.eventId, request, answer: response });
      }
    }
    // Failed turns have no completed episode. Preserve their original input
    // locally so a follow-up can resume the objective, without replaying tools,
    // progress, old recall receipts or historical checkpoints.
    const interruptedTurns: NonNullable<RecallReceipt['interruptedTurns']> = [];
    if (this.store) {
      const events = await this.store.load(meta.id);
      const current = events.findIndex(
        (event) => event.type === 'message/user' && event.eventId === promptId,
      );
      const starts = events.flatMap((event, i) =>
        event.type === 'message/user' && i < current ? [i] : [],
      );
      const lastCompleted = events.findLastIndex(
        (event, i) => i < current && event.type === 'turn/end' && event.reason === 'completed',
      );
      const unresolved = starts.filter((start) => start > lastCompleted);
      // Keep the objective at the beginning of an interrupted run even after
      // many short follow-ups; bound recent steering independently of it.
      const candidates = [...new Set([...unresolved.slice(0, 1), ...unresolved.slice(-3)])];
      for (const start of candidates) {
        signal?.throwIfAborted();
        const user = events[start];
        if (user?.type !== 'message/user') continue;
        const end = events.findIndex((event, i) => i > start && event.type === 'message/user');
        const span = events.slice(start + 1, end);
        const terminal = events.findLast(
          (event) => event.type === 'turn/end' && event.promptId === user.eventId,
        );
        if (terminal?.type === 'turn/end' && terminal.reason === 'completed') continue;
        const selection = span.findLast((event) => event.type === 'memory/selection');
        if (
          snapshot.hasSuppression &&
          (selection?.type !== 'memory/selection' ||
            selection.receipt.policyRevision < snapshot.revision)
        )
          continue;
        const indexed = await this.index.evidence?.(identity, user.eventId);
        if (indexed?.excluded) continue;
        const request = user.content
          .filter((block) => block.kind === 'text')
          .map((block) => block.text)
          .join('\n');
        if (!request.trim() || /^(remember:|forget my |change my )/iu.test(request.trim()))
          continue;
        interruptedTurns.push({
          promptId: user.eventId,
          fromSeq: start + 1,
          toSeq: end,
          request: request.slice(0, 4000),
          reason:
            terminal?.type === 'turn/end' && terminal.reason === 'aborted'
              ? 'aborted'
              : terminal?.type === 'turn/end'
                ? 'error'
                : 'interrupted',
        });
      }
    }
    return {
      version: 2,
      promptId,
      dialogue,
      policyRevision: snapshot.revision,
      ...(commandResult ? { commandResult } : {}),
      memories,
      episodes,
      ...(interruptedTurns.length ? { interruptedTurns } : {}),
      omitted: dialogueOmitted || snapshot.items.length > memories.length,
    };
  }
}

export { personalModelMessages } from '../loop/to-model-messages.js';

/** Shrink optional dialogue while retaining exact source ranges for expansion. */
export function fitDialogue(receipt: RecallReceipt, characterLimit: number): RecallReceipt {
  let remaining = Math.max(0, characterLimit);
  const dialogue: NonNullable<RecallReceipt['dialogue']> = [];
  for (const exchange of (receipt.dialogue ?? []).toReversed()) {
    if (remaining < 256) break;
    const request = { ...exchange.request };
    const answer = { ...exchange.answer };
    request.text = request.text.slice(0, Math.min(request.text.length, Math.floor(remaining / 4)));
    request.to = request.from + request.text.length;
    remaining -= request.text.length;
    answer.text = answer.text.slice(0, remaining);
    answer.to = answer.from + answer.text.length;
    remaining -= answer.text.length;
    dialogue.unshift({ ...exchange, request, answer });
  }
  return { ...receipt, dialogue, omitted: true };
}
