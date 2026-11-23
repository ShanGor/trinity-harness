import type {
  ToolRegistry,
  ToolCall,
  ToolContextInput,
  ToolResult,
  ToolSchema,
  SessionStore,
} from '@trinity-harness/contracts';

/** Chat exposes attachment reading only. No shell, skills, delegation, or live browser routes. */
export class ConversationToolRegistry implements ToolRegistry {
  constructor(
    private readonly tools: ToolRegistry,
    private readonly store?: SessionStore,
  ) {}
  register(): Disposable {
    throw new Error('Conversation tools are immutable');
  }
  schemas(): ToolSchema[] {
    return this.tools.schemas().filter((tool) => ['read_blob', 'recall'].includes(tool.name));
  }
  concurrencyOf(): 'parallel' {
    return 'parallel';
  }
  async execute(call: ToolCall, ctx: ToolContextInput): Promise<ToolResult> {
    if (!this.schemas().some((tool) => tool.name === call.name))
      return {
        isError: true,
        value: {
          code: 'CHAT_CAPABILITY_DENIED',
          message: 'Create Work with an explicit workspace to execute this operation.',
        },
      };
    if (call.name === 'recall') return this.tools.execute(call, ctx);
    const uri = (call.args as { uri?: unknown } | null)?.uri;
    const events = (await this.store?.load(ctx.sessionId)) ?? [];
    const authorized = events.some(
      (event) =>
        event.type === 'message/user' &&
        event.content.some(
          (block) => (block.kind === 'image' || block.kind === 'file') && block.uri === uri,
        ),
    );
    if (!authorized)
      return {
        isError: true,
        value: {
          code: 'CHAT_ATTACHMENT_DENIED',
          message: 'Only attachments supplied in this conversation can be read.',
        },
      };
    return this.tools.execute(call, ctx);
  }
}
