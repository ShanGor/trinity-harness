import type {
  AgentLoop,
  EventSink,
  LLMPort,
  LLMRequest,
  RunTurnOptions,
  SessionStore,
  ToolCall,
  ToolRegistry,
  TurnOutcome,
} from '@trinity-harness/contracts';

import { toModelMessages } from './to-model-messages.js';

const DEFAULT_MAX_STEPS = 32;

export interface AgentLoopOptions {
  llm: LLMPort;
  /** e.g. "anthropic/claude-sonnet-4-20250514". */
  model: string;
  systemPrompt?: string | undefined;
  tools: ToolRegistry;
  store: SessionStore;
  workspaceRoot: string;
  maxSteps?: number | undefined;
}

function meta(): { eventId: string; at: string } {
  return { eventId: crypto.randomUUID(), at: new Date().toISOString() };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turn-driving Agent Loop (docs/design.md §6). M1 simplifications: steps run
 * sequentially (parallel tool pool is M2/M4), the four interception points
 * land with approvals in M3. Cancellation is AbortSignal-driven end to end.
 */
export class CoreAgentLoop implements AgentLoop {
  private readonly maxSteps: number;

  constructor(private readonly opts: AgentLoopOptions) {
    this.maxSteps = opts.maxSteps ?? DEFAULT_MAX_STEPS;
  }

  async run(
    sessionId: string,
    prompt: string,
    sink: EventSink,
    runOpts?: RunTurnOptions,
  ): Promise<TurnOutcome> {
    const signal = runOpts?.signal;
    const { store, tools, llm } = this.opts;
    const ctx = { sessionId, workspaceRoot: this.opts.workspaceRoot, signal };

    const throwIfAborted = (): void => {
      if (signal?.aborted) {
        throw new DOMException('aborted', 'AbortError');
      }
    };

    let steps = 0;
    let reason: TurnOutcome['reason'] = 'completed';
    let detail: string | undefined;

    await store.append(sessionId, [
      {
        ...meta(),
        type: 'message/user',
        surfaceOp: 'append',
        content: [{ kind: 'text', text: prompt }],
      },
    ]);

    try {
      while (true) {
        throwIfAborted();
        // Reached only when the previous step ended with tool calls: the cap
        // counts completed model requests, so a turn finishing exactly on the
        // limit still reports 'completed'.
        if (steps >= this.maxSteps) {
          reason = 'error';
          detail = `step limit (${this.maxSteps}) reached`;
          break;
        }
        steps += 1;

        const history = await store.load(sessionId);
        const request: LLMRequest = {
          model: this.opts.model,
          system: this.opts.systemPrompt,
          messages: toModelMessages(history),
          tools: tools.schemas(),
          signal,
        };
        const chunks = await llm.stream(request);

        let text = '';
        let reasoningText = '';
        let reasoningSignature: string | undefined;
        const toolCalls: ToolCall[] = [];
        for await (const chunk of chunks) {
          throwIfAborted();
          if (chunk.kind === 'text-delta') {
            text += chunk.text;
            sink.emit({ type: 'text-delta', text: chunk.text });
          } else if (chunk.kind === 'reasoning-delta') {
            // Reasoning is persisted on the assistant event so subsequent
            // steps replay it (MiniMax-M3 requires the last reasoning output).
            if (chunk.signature !== undefined) {
              reasoningSignature = chunk.signature;
            }
            if (chunk.text.length > 0) {
              reasoningText += chunk.text;
              sink.emit({ type: 'reasoning-delta', text: chunk.text });
            }
          } else if (chunk.kind === 'tool-call') {
            toolCalls.push({ id: chunk.call.id, name: chunk.call.name, args: chunk.call.args });
          } else if (chunk.kind === 'finish' && chunk.reason === 'error') {
            throw new Error('LLM stream finished with an error');
          }
        }

        if (text.length > 0 || reasoningText.length > 0) {
          await store.append(sessionId, [
            {
              ...meta(),
              type: 'message/assistant',
              surfaceOp: 'append',
              content: [
                ...(reasoningText.length > 0
                  ? [
                      {
                        kind: 'reasoning' as const,
                        text: reasoningText,
                        ...(reasoningSignature !== undefined
                          ? { signature: reasoningSignature }
                          : {}),
                      },
                    ]
                  : []),
                ...(text.length > 0 ? [{ kind: 'text' as const, text }] : []),
              ],
            },
          ]);
          if (text.length > 0) {
            sink.emit({ type: 'message/assistant', content: text });
          }
        }

        if (toolCalls.length === 0) {
          break; // model is done — turn complete
        }

        // M1: execute sequentially, strictly in model-output order (design.md §6.3).
        for (const call of toolCalls) {
          throwIfAborted();
          await store.append(sessionId, [
            {
              ...meta(),
              type: 'tool/call',
              callId: call.id,
              name: call.name,
              args: call.args,
            },
          ]);
          sink.emit({ type: 'tool/call', call: { ...call, args: call.args } });
          const result = await tools.execute(call, ctx);
          await store.append(sessionId, [
            {
              ...meta(),
              type: 'tool/result',
              callId: call.id,
              value: result.value,
              isError: result.isError,
            },
          ]);
          sink.emit({ type: 'tool/result', callId: call.id, name: call.name, result });
        }
      }
    } catch (err) {
      if (isAbortError(err)) {
        reason = 'aborted';
      } else {
        reason = 'error';
        detail = errorMessage(err);
      }
    }

    await store.append(sessionId, [
      {
        ...meta(),
        type: 'turn/end',
        reason,
        ...(detail !== undefined ? { detail } : {}),
      },
    ]);
    sink.emit({ type: 'turn/end', reason, ...(detail !== undefined ? { detail } : {}) });

    return { reason, steps };
  }
}
