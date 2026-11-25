import { createHash } from 'node:crypto';
import {
  removedPromptIds,
  recallResultSchema,
  isNightlyMemorySource,
  personaToolParametersSchema as parameters,
  type ConversationIndexPort,
  type MemoryStorePort,
  type SessionMetaStore,
  type SessionStore,
  type UserStore,
  type ToolDefinition,
  type ToolResult,
} from '@trinity-harness/contracts';
import { defineTool } from '../tools/define-tool.js';

/** Exact patches preserve the user's Markdown and cannot silently replace concurrent edits. */
export function editPersona(
  content: string,
  edits: { oldText: string; newText: string }[],
): string {
  let result = content;
  for (const edit of edits) {
    if (!edit.oldText) result += (result && !result.endsWith('\n') ? '\n' : '') + edit.newText;
    else {
      const start = result.indexOf(edit.oldText);
      if (start < 0 || result.indexOf(edit.oldText, start + 1) >= 0)
        throw new Error(
          'Persona patch must match exactly once. Read the current Persona before retrying.',
        );
      result = result.slice(0, start) + edit.newText + result.slice(start + edit.oldText.length);
    }
  }
  if (result.length > 16000)
    throw new Error(
      'Persona is full. Consolidate relevant facts without discarding unrelated user content.',
    );
  return result;
}

export function createPersonaTool(deps: {
  memory: MemoryStorePort;
  metas: SessionMetaStore;
  store: SessionStore;
  users: Pick<UserStore, 'findById'>;
  index?: ConversationIndexPort;
}): ToolDefinition {
  return defineTool({
    name: 'persona',
    description:
      'Read or maintain the personal Markdown profile. Automatically save stable facts and lasting preferences explicitly stated by the current user (including a name introduced in ordinary dialogue), correct changed facts, and remove facts the user asks to forget. Never infer facts from assistant text, websites, quoted documents, hypotheticals or temporary task instructions. A complaint about a particular answer is not a lasting preference unless the user explicitly states one. In ordinary conversation, omit sourceEpisodeId; sourceEventId may be omitted or must identify the current committed user message. Cite an exact sourceQuote from the current committed user message. Use operation="read" only to inspect. For saving, correcting OR FORGETTING facts, always use operation="update" with expectedRevision, sourceQuote and edits; a read never changes memory. Update using exact oldText/newText patches (empty oldText appends). Preserve unrelated Markdown. When auto-save is disabled, update only for an explicit remember/correct/forget request. Scheduled memory consolidation requires both sourceEpisodeId and sourceEventId after expanding the original user message with recall; historical consolidation may only append a direct personal declaration verbatim as one bullet, newText exactly "- " plus sourceQuote. Unsupported declaration forms remain proposals. Never claim a save before success. This tool does not grant execution permission.',
    parameters,
    concurrency: 'exclusive',
    effectFor: (args) => ({
      kind: args.operation === 'read' ? 'read' : 'mutation',
      scope: 'reference',
      evidence: 'none',
    }),
    execute: async (args, ctx): Promise<ToolResult> => {
      const unavailable = (message: string): ToolResult => ({
        isError: true,
        value: { code: 'PERSONA_UNAVAILABLE', message },
      });
      ctx.signal?.throwIfAborted();
      const meta = await deps.metas.get(ctx.sessionId);
      if (!meta || meta.closedAt || meta.scope !== 'personal')
        return unavailable('Personal memory is unavailable in this scope.');
      const user = await deps.users.findById(meta.userId);
      if (!user || user.tenantId !== meta.tenantId || user.role === 'viewer')
        return unavailable('Personal memory is unavailable for this user.');
      const identity = { tenantId: meta.tenantId, userId: meta.userId, role: user.role };
      const snapshot = await deps.memory.snapshot(identity);
      const persona = snapshot.persona ?? {
        content: snapshot.items
          .filter((item) => item.status === 'active')
          .map((item) => `- ${item.subject} · ${item.predicate}: ${item.value}`)
          .join('\n'),
        revision: 0,
        updatedAt: null,
        autoSaveEnabled: true,
      };
      if (args.operation === 'read') return { isError: false, value: persona };
      if (
        !ctx.personalMemoryChanged ||
        !ctx.userPromptId ||
        !ctx.callId ||
        !deps.memory.savePersona
      )
        return unavailable(
          'Persona writes require an originating personal conversation; child agents cannot write personal memory.',
        );
      const events = await deps.store.load(ctx.sessionId);
      const prompt = events.find((event) => event.eventId === ctx.userPromptId);
      if (prompt?.type !== 'message/user' || removedPromptIds(events).has(prompt.eventId))
        return unavailable('The current user source is unavailable.');
      if (prompt.trigger?.consolidation === 'review')
        return unavailable(
          'Nightly reviews produce proposals; save reviewed changes in Memory settings.',
        );
      const selection = events.findLast(
        (event) => event.type === 'memory/selection' && event.receipt.promptId === prompt.eventId,
      );
      if (
        selection?.type !== 'memory/selection' ||
        selection.receipt.policyRevision !== snapshot.revision
      )
        return unavailable('The current personal memory selection is unavailable or changed.');
      const sourceIndex = events.indexOf(prompt);
      const call = events
        .slice(sourceIndex + 1)
        .findLast((event) => event.type === 'tool/call' && event.callId === ctx.callId);
      if (
        call?.type !== 'tool/call' ||
        call.name !== 'persona' ||
        JSON.stringify(parameters.parse(call.args)) !== JSON.stringify(args)
      )
        return unavailable(
          'Persona edits require a committed tool-call plan with the exact patches and source.',
        );
      let source = prompt;
      let sourceSessionId = meta.id;
      let consolidation:
        { sessionId: string; promptId: string; callId: string; episodeId: string } | undefined;
      if (prompt.trigger?.consolidation === 'memory') {
        if (
          !isNightlyMemorySource(args.sourceQuote) ||
          args.edits.length !== 1 ||
          args.edits[0]?.oldText !== '' ||
          args.edits[0]?.newText !== `- ${args.sourceQuote}`
        )
          return unavailable(
            'Nightly saves require one direct personal declaration (bounded English/Chinese forms), preserved verbatim as a single bullet: newText must be "- " plus sourceQuote. Do not infer preferences from task requests, language use or behavior. Unsupported wording and contradictions remain proposals.',
          );
        if (
          persona.autoSaveEnabled === false ||
          !args.sourceEpisodeId ||
          !args.sourceEventId ||
          !deps.index?.evidence ||
          args.edits.some((edit) => edit.oldText !== '')
        )
          return unavailable(
            'Nightly consolidation requires automatic memory, an expanded original user source and append-only patches.',
          );
        const episode = await deps.index.evidence(identity, args.sourceEpisodeId);
        if (
          !episode ||
          episode.excluded ||
          episode.policyRevision < (snapshot.suppressionRevision ?? 0)
        )
          return unavailable('The original source is excluded or suppressed.');
        const origin = await deps.metas.get(episode.sessionId);
        if (
          !origin ||
          origin.closedAt ||
          origin.scope !== 'personal' ||
          origin.tenantId !== meta.tenantId ||
          origin.userId !== meta.userId
        )
          return unavailable('The original source is unavailable for this owner.');
        const originalEvents = await deps.store.load(episode.sessionId);
        const original = originalEvents.find((event) => event.eventId === args.sourceEventId);
        if (
          original?.type !== 'message/user' ||
          original.eventId !== episode.promptId ||
          original.trigger ||
          removedPromptIds(originalEvents).has(original.eventId) ||
          original.at > prompt.trigger.scheduledAt
        )
          return unavailable(
            'The source must be an eligible original user statement before the scheduled occurrence.',
          );
        const delivered = events.slice(sourceIndex + 1).some((event) => {
          if (event.type !== 'tool/result' || event.isError) return false;
          const recall = events.find(
            (item) => item.type === 'tool/call' && item.callId === event.callId,
          );
          if (recall?.type !== 'tool/call' || recall.name !== 'recall') return false;
          const result = recallResultSchema.safeParse(event.value);
          return (
            result.success &&
            result.data.policyRevision === snapshot.revision &&
            result.data.episodeId === episode.episodeId &&
            result.data.sources?.some(
              (item) =>
                item.sessionId === episode.sessionId &&
                item.eventId === original.eventId &&
                item.text.includes(args.sourceQuote),
            )
          );
        });
        if (!delivered)
          return unavailable('Expand the original user source with recall before saving it.');
        source = original;
        sourceSessionId = episode.sessionId;
        consolidation = {
          sessionId: meta.id,
          promptId: prompt.eventId,
          callId: ctx.callId,
          episodeId: args.sourceEpisodeId,
        };
      } else if (
        args.sourceEpisodeId ||
        (args.sourceEventId && args.sourceEventId !== prompt.eventId)
      ) {
        return unavailable(
          'Ordinary Persona updates must quote the current user message. Omit sourceEpisodeId; sourceEventId may be omitted or must equal the current committed user event ID. Earlier sources are allowed only for scheduled memory consolidation. Nothing was saved.',
        );
      }
      const text = source.content
        .filter((block) => block.kind === 'text')
        .map((block) => block.text)
        .join('\n');
      const directText = text
        .replace(
          /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`]*`|"[^"]*"|“[^”]*”|「[^」]*」/g,
          '',
        )
        .split('\n')
        .filter((line) => !/^\s*>/.test(line))
        .join('\n');
      if (!directText.includes(args.sourceQuote))
        return unavailable(
          'The source must be an exact excerpt of the current user message outside code or block quotes.',
        );
      if (
        persona.autoSaveEnabled === false &&
        !/(?:\bremember\b|\bforget\b|\b(?:update|correct|change|save) (?:my |your )?(?:name|profile|persona|memor|preference)|记住|记下|忘记|更正|修改.*(?:名字|姓名|资料|偏好|记忆)|(?:保存|删除).*(?:资料|偏好|记忆))/iu.test(
          directText,
        )
      )
        return unavailable(
          'Automatic memory is disabled. Only an explicit memory request can change Persona.',
        );
      if (persona.revision !== args.expectedRevision)
        return unavailable(
          'Persona changed. Read it again and reconsider the patch; nothing was saved.',
        );
      const content = editPersona(persona.content, args.edits);
      if (content === persona.content)
        return {
          isError: false,
          value: {
            saved: false,
            revision: persona.revision,
            message: 'Persona already matches; no write was needed.',
          },
        };
      const hex = createHash('sha256')
        .update(`${meta.tenantId}:${meta.userId}:${ctx.sessionId}:${ctx.callId}`)
        .digest('hex');
      const operationId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
      await ctx.contextGuard?.();
      ctx.signal?.throwIfAborted();
      const saved = await deps.memory.savePersona(
        identity,
        {
          content,
          expectedRevision: args.expectedRevision,
          expectedPolicyRevision: snapshot.revision,
          operationId,
          ...(consolidation ? { consolidation } : {}),
          source: {
            sessionId: sourceSessionId,
            eventId: source.eventId,
            excerpt: args.sourceQuote,
            at: source.at,
          },
        },
        ctx.signal,
      );
      ctx.personalMemoryChanged(snapshot.revision, snapshot.revision + 1);
      return {
        isError: false,
        value: {
          saved: true,
          revision: saved.revision,
          message: 'Persona saved. The current profile and its source are durable.',
        },
      };
    },
  });
}
