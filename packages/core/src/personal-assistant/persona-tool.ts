import { createHash } from 'node:crypto';
import { z } from 'zod';
import {
  removedPromptIds,
  type MemoryStorePort,
  type SessionMetaStore,
  type SessionStore,
  type UserStore,
  type ToolDefinition,
  type ToolResult,
} from '@trinity-harness/contracts';
import { defineTool } from '../tools/define-tool.js';

const parameters = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('read') }).strict(),
  z
    .object({
      operation: z.literal('update'),
      expectedRevision: z.number().int().nonnegative(),
      sourceQuote: z.string().min(1).max(4000),
      edits: z
        .array(
          z.object({ oldText: z.string().max(16000), newText: z.string().max(16000) }).strict(),
        )
        .min(1)
        .max(8),
    })
    .strict(),
]);

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
}): ToolDefinition {
  return defineTool({
    name: 'persona',
    description:
      'Read or maintain the personal Markdown profile. Automatically save stable facts and lasting preferences explicitly stated by the current user (including a name introduced in ordinary dialogue), correct changed facts, and remove facts the user asks to forget. Never infer facts from assistant text, websites, quoted documents, hypotheticals or temporary task instructions. Cite an exact sourceQuote from the current committed user message. Read first; update using exact oldText/newText patches (empty oldText appends). Preserve unrelated Markdown. When auto-save is disabled, update only for an explicit remember/correct/forget request. Never claim a save before success. This tool does not grant execution permission.',
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
      const text = prompt.content
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
          source: {
            sessionId: meta.id,
            eventId: prompt.eventId,
            excerpt: args.sourceQuote,
            at: prompt.at,
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
