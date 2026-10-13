import type { SkillRuntimePort } from '@trinity-harness/contracts';
import type {
  AgentLoop,
  ApprovalRequester,
  ApprovalStore,
  BlobStore,
  ContentBlock,
  EventSink,
  LLMPort,
  LLMRequest,
  QuotaWindow,
  RunTurnOptions,
  SessionStore,
  StreamChunk,
  ToolCall,
  ToolRegistry,
  ToolResult,
  TurnOutcome,
  UsagePort,
  ModelPricing,
  ModelUsage,
  TokenUsage,
  ToolContextInput,
} from '@trinity-harness/contracts';
import {
  BROWSER_LIMITS,
  browserErrorSchema,
  turnStepBudgetSchema,
  windowStart,
} from '@trinity-harness/contracts';
import { sumTokenUsage, newId } from '@trinity-harness/shared';

import { normalizeTokenUsage, priceUsage } from '../llm/usage.js';
import type { ContextManager } from '../context/context-manager.js';
import { PolicyToolRegistry } from '../policy-tool-registry.js';
import {
  approvalDuration,
  tokenCounter,
  toolCounter,
  tracer,
  turnDuration,
  turnSteps,
} from '../telemetry.js';
import { browserDiagnosticBytes, resolveBrowserImage } from '../tools/browser-artifacts.js';
import { matchesCommandPrefix } from '../tools/command-prefix.js';
import { bashReferencesSensitiveFile } from '../tools/sensitive-files.js';
import { progressGuidance } from './progress-guidance.js';
import { toModelMessages } from './to-model-messages.js';
import { answerGrounding } from './answer-grounding.js';

const DEFAULT_MAX_PARALLEL_TOOLS = 4;
/** M4 spill default: tool results above 50 KB go to the BlobStore (§7). */
const DEFAULT_SPILL_THRESHOLD_BYTES = 50_000;

export interface AgentLoopOptions {
  llm: LLMPort;
  /** e.g. "anthropic/claude-sonnet-4-20250514". */
  model: string;
  systemPrompt?: string | undefined;
  tools: ToolRegistry;
  store: SessionStore;
  workspaceRoot: string;
  skills?: SkillRuntimePort | undefined;
  maxSteps?: number | undefined;
  /** Rolling pool size for parallel-class tools (design.md §6.3). */
  maxParallelTools?: number | undefined;
  /**
   * M3: human-in-the-loop channel for policy 'ask' decisions (docs/design.md
   * §12.2). Absent ⇒ 'ask' resolves to rejected (fail-closed).
   */
  approvals?: ApprovalRequester | undefined;
  /**
   * M3: durable approval trail (docs/design.md §15 `approvals`). Failures are
   * logged, never thrown — the event log remains the primary 留痕.
   */
  approvalStore?: ApprovalStore | undefined;
  /**
   * M4: context manager (docs/design.md §5.1). Checked between steps; when
   * the projected context exceeds its budget it appends `compaction/summary`
   * and the fold replaces the covered range.
   */
  context?: ContextManager | undefined;
  /**
   * M4: large tool results are spilled to the BlobStore and only a `blob://`
   * reference + preview is committed to the log (docs/design.md §7).
   */
  spill?: { store: BlobStore; thresholdBytes?: number | undefined } | undefined;
  /**
   * M4: per-step system-prompt augmentation (docs/design.md §9: LSP
   * diagnostics context injection). Cached by the implementation.
   */
  augmentSystem?: ((sessionId: string) => Promise<string | undefined>) | undefined;
  /**
   * M4 multimodal: resolves `blob://` URIs to bytes for the gateway's
   * provider-native image/file encoding (composition root wires the
   * BlobStore; fail-closed when absent).
   */
  resolveBlob?: ((uri: string) => Promise<Uint8Array>) | undefined;
  /**
   * M5: token metering + tenant quota gate (docs/design.md §17). Checked
   * before every model request (fail-closed: store failure or an exceeded
   * quota ends the turn with a friendly error); usage chunks are recorded
   * per attempted model request. Session usage is durable; the tenant quota
   * projection remains best-effort.
   */
  usage?: UsagePort | undefined;
  pricing?: ModelPricing | undefined;
}

function meta(): { eventId: string; at: string } {
  return { eventId: newId(), at: new Date().toISOString() };
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && err.name === 'AbortError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Bounded, log-safe argument preview for approval requests (§5 redaction). */
function preview(value: unknown, max = 500): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/**
 * Turn-driving Agent Loop (docs/design.md §6). M2: parallel-class tools run
 * in a rolling pool while tool/call + tool/result stay committed in strict
 * model-output order (replay determinism). M3: per-call permission gating —
 * policy 'denied' synthesizes an isError result without executing; 'ask'
 * blocks the wave on the human approval channel (fail-closed: no channel or
 * no reply ⇒ rejected). Cancellation is AbortSignal-driven end to end.
 */
export class CoreAgentLoop implements AgentLoop {
  private readonly maxSteps: number;
  private readonly maxParallel: number;

  constructor(private readonly opts: AgentLoopOptions) {
    this.maxSteps = turnStepBudgetSchema.parse(opts.maxSteps);
    this.maxParallel = Math.max(1, opts.maxParallelTools ?? DEFAULT_MAX_PARALLEL_TOOLS);
  }

  async run(
    sessionId: string,
    prompt: string,
    sink: EventSink,
    runOpts?: RunTurnOptions,
  ): Promise<TurnOutcome> {
    const signal = runOpts?.signal;
    const { store, tools, llm } = this.opts;
    const actor = runOpts?.actor;
    const tenantId = runOpts?.tenantId;
    const appendOpts = actor !== undefined ? { actor } : undefined;
    const ctx: ToolContextInput = {
      sessionId,
      workspaceRoot: this.opts.workspaceRoot,
      signal,
      tenantId,
    };
    // M5 OTel: one span per turn/step/tool/approval (design.md §17). No-op
    // without a registered SDK (@opentelemetry/api global fallthrough).
    const turnSpan = tracer.startSpan('trinity.turn', {
      attributes: {
        'trinity.session_id': sessionId,
        'trinity.model': this.opts.model,
        ...(tenantId !== undefined ? { 'trinity.tenant_id': tenantId } : {}),
      },
    });
    const turnStartedAt = Date.now();
    let steps = 0;
    let reason: TurnOutcome['reason'] = 'completed';
    let detail: string | undefined;
    try {
      // M3: policy gating (docs/design.md §12). No policy ⇒ M2 behavior.
      const gate = new PolicyToolRegistry(tools, runOpts?.policy);
      const researchAvailable = tools.schemas().some((tool) => tool.name === 'research');

      const throwIfAborted = (): void => {
        if (signal?.aborted) {
          throw new DOMException('aborted', 'AbortError');
        }
      };

      // The user message: committed by the CALLER when it passes `promptSeq`
      // (distributed + inline HTTP paths both commit before enqueueing so the
      // exact seq is known, docs/design.md §11.3); appended here otherwise.
      // M4: `runOpts.content` (multimodal blocks) replaces the plain-text body.
      const userContent: ContentBlock[] =
        runOpts?.content !== undefined && runOpts.content.length > 0
          ? runOpts.content
          : [{ kind: 'text', text: prompt }];
      const promptPreview =
        userContent.find((b) => b.kind === 'text')?.text ??
        userContent
          .map((b) =>
            b.kind === 'image' || b.kind === 'file' ? `[${b.kind}: ${b.uri}]` : '[content block]',
          )
          .join(' ');
      const appendedUser =
        runOpts?.promptSeq === undefined
          ? await store.append(
              sessionId,
              [
                {
                  ...meta(),
                  type: 'message/user',
                  surfaceOp: 'append',
                  content: userContent,
                },
              ],
              appendOpts,
            )
          : null;
      const promptSeq = runOpts?.promptSeq ?? appendedUser!.from;
      const promptId = (await store.load(sessionId))[promptSeq - 1]!.eventId;
      const persistUsage = async (usage: ModelUsage): Promise<void> => {
        await store.append(sessionId, [{ ...meta(), type: 'model/usage', usage }], appendOpts);
        sink.emit({ type: 'model/usage', usage });
      };
      ctx.recordUsage = (usage) => persistUsage({ ...usage, promptId, purpose: 'subagent' });
      const recordUsage = async (
        model: string,
        purpose: ModelUsage['purpose'],
        samples: TokenUsage[],
      ): Promise<void> => {
        const tokens = normalizeTokenUsage(sumTokenUsage(samples));
        await persistUsage({
          requestId: newId(),
          promptId,
          model,
          purpose,
          tokens,
          ...priceUsage(model, tokens, this.opts.pricing ?? {}),
        });
        const inputTokens = tokens.inputTokens ?? 0;
        const outputTokens = tokens.outputTokens ?? 0;
        const tokenAttrs = {
          'trinity.model': model,
          ...(tenantId !== undefined ? { 'trinity.tenant_id': tenantId } : {}),
        };
        tokenCounter.add(inputTokens, { ...tokenAttrs, 'trinity.token_kind': 'input' });
        tokenCounter.add(outputTokens, { ...tokenAttrs, 'trinity.token_kind': 'output' });
        if (this.opts.usage && tenantId && (inputTokens > 0 || outputTokens > 0)) {
          try {
            await this.opts.usage.record({ tenantId, sessionId, model, inputTokens, outputTokens });
          } catch (err) {
            console.error('[CoreAgentLoop] usage record failed', err);
          }
        }
      };

      const checkCancellation = async (): Promise<boolean> =>
        (await store.load(sessionId)).some(
          (event) => event.type === 'turn/cancel_requested' && promptSeq <= event.throughPromptSeq,
        );
      if (await checkCancellation()) reason = 'aborted';

      // Prompt gate (docs/design.md §12): the user message is treated like a
      // tool call. Denied ⇒ the row is removed again (never-ran prompts leave
      // no trace, see SessionStore.remove) and the turn ends immediately.
      if (
        reason === 'completed' &&
        gate &&
        gate.decide({ id: `prompt-${promptSeq}`, name: 'prompt', args: promptPreview }) !==
          'allowed'
      ) {
        const promptCall: ToolCall = {
          id: `prompt-${promptSeq}`,
          name: 'prompt',
          args: promptPreview,
        };
        const outcome = await this.gateCall(
          sessionId,
          promptCall,
          promptPreview,
          sink,
          appendOpts,
          signal,
        );
        if (outcome === 'rejected') {
          await store.remove?.(sessionId, promptSeq);
          reason = 'error';
          detail = 'prompt rejected by permission policy';
        }
      }

      try {
        // `promptGated` ⇒ skip the model loop entirely; turn/end still lands.
        while (reason === 'completed') {
          throwIfAborted();
          if (await checkCancellation()) throw new DOMException('cancelled', 'AbortError');
          // Reached only when the previous step ended with tool calls: the cap
          // counts completed model requests, so a turn finishing exactly on the
          // limit still reports 'completed'.
          if (steps >= this.maxSteps) {
            reason = 'error';
            detail = `step limit (${this.maxSteps}) reached`;
            break;
          }
          steps += 1;

          // M4 context pressure: compact BEFORE the request so history entering
          // a new turn is bounded, and again between steps after tool waves
          // (docs/design.md §6.1 "上下文压力/溢出 → 触发 compaction"). No-op
          // when under budget.
          if (this.opts.context) {
            await this.opts.context.compact(sessionId, {
              signal,
              appendOpts,
              sink,
              beforeModelCall: async () => {
                const denied = this.opts.usage && tenantId ? await this.checkQuota(tenantId) : null;
                if (denied) throw new Error(denied);
              },
              recordUsage: (model, samples) => recordUsage(model, 'compaction', samples),
            });
          }

          await this.opts.skills?.prepare({
            sessionId,
            workspaceRoot: this.opts.workspaceRoot,
            prompt: steps === 1 ? prompt : undefined,
            policy: runOpts?.policy,
            signal,
            appendOpts,
          });
          let history = await store.load(sessionId);
          const advice = progressGuidance(
            history,
            promptSeq,
            steps,
            this.maxSteps,
            researchAvailable,
          );
          const previousGuidance = [...history]
            .reverse()
            .find((event) => event.type === 'turn/guidance' && event.promptSeq === promptSeq);
          const currentAdvice =
            advice ??
            (previousGuidance
              ? 'The previous progress warning has cleared. Continue toward the user request; use the evidence already collected.'
              : null);
          if (
            currentAdvice &&
            (previousGuidance?.type !== 'turn/guidance' ||
              previousGuidance.advice !== currentAdvice)
          ) {
            await store.append(
              sessionId,
              [{ ...meta(), type: 'turn/guidance', promptSeq, advice: currentAdvice }],
              appendOpts,
            );
            history = await store.load(sessionId);
          }
          // M4: per-step system augmentation (LSP diagnostics injection, §9).
          const augmented = await this.opts.augmentSystem?.(sessionId);
          const browserBudgetExhausted = history.slice(promptSeq).some((event) => {
            if (event.type !== 'tool/result' || !event.isError) return false;
            const parsed = browserErrorSchema.safeParse(event.value);
            return parsed.success && parsed.data.recovery === 'conclude';
          });
          const diagnosticsExhausted =
            browserDiagnosticBytes(history, promptSeq) >=
            BROWSER_LIMITS.diagnosticTurn - BROWSER_LIMITS.callsPerStep * BROWSER_LIMITS.diagnostic;
          const concluding =
            steps === this.maxSteps || browserBudgetExhausted || diagnosticsExhausted;
          const conclusion = concluding
            ? 'This is the final step of the turn. Produce your final answer now using the evidence already collected. State uncertainties and incomplete work explicitly; do not claim success without evidence. Cite retrieved sources when relevant. Do not call tools.'
            : undefined;
          const system = [
            this.opts.systemPrompt,
            augmented,
            conclusion,
            'For workspace text-file inspection, use read_file (and glob to locate files) instead of Bash commands such as cat, head, tail, sed, or grep. Reserve Bash for running commands, tests, builds, version-control operations, and other shell tasks. Sensitive-file reads are checked by the agent and may trigger the normal approval flow; call read_file directly when needed, do not invoke a separate approval tool or bypass the gate with Bash, and stop if access is rejected. Never repeat secret values in your final answer.',
            'Keep progress updates brief. The final answer must synthesize the user request and link factual claims to reference documents actually read, using Markdown links. Distinguish supported findings, inference and unresolved questions. The interface lists observed sources separately; do not invent citations or describe internal bookkeeping.',
          ]
            .filter((s) => s !== undefined)
            .join('\n\n');
          const request: LLMRequest = {
            model: this.opts.model,
            system,
            messages: toModelMessages(history),
            tools: concluding ? [] : tools.schemas(),
            signal,
            ...(this.opts.resolveBlob !== undefined
              ? {
                  resolveBlob: async (uri: string): Promise<Uint8Array> => {
                    if (uri.startsWith('blob://browser/')) {
                      if (!this.opts.spill?.store)
                        throw new Error('Browser image store unavailable');
                      return resolveBrowserImage(this.opts.spill.store, history, sessionId, uri);
                    }
                    return this.opts.resolveBlob!(uri);
                  },
                }
              : {}),
          };

          // M5 quota gate (docs/design.md §17 "beforeModelCall 拦截点实时判定"):
          // deny BEFORE spending tokens. Fail-closed: a quota-store failure
          // denies too (AGENTS.md §3.4).
          if (this.opts.usage && tenantId) {
            const denied = await this.checkQuota(tenantId);
            if (denied) {
              reason = 'error';
              detail = denied;
              break;
            }
          }

          const stepSpan = tracer.startSpan('trinity.step', {
            attributes: { 'trinity.step': steps, 'trinity.model': this.opts.model },
          });
          let chunks: AsyncIterable<StreamChunk>;
          try {
            chunks = await llm.stream(request);
          } catch (err) {
            stepSpan.recordException(err as Error);
            stepSpan.setStatus({ code: 2, message: errorMessage(err) });
            stepSpan.end();
            await recordUsage(this.opts.model, 'assistant', []);
            throw err;
          }

          let text = '';
          let reasoningText = '';
          let reasoningSignature: string | undefined;
          const usageSamples: TokenUsage[] = [];
          const toolCalls: ToolCall[] = [];
          try {
            for await (const chunk of chunks) {
              if (chunk.kind === 'usage') {
                usageSamples.push(chunk);
                continue;
              }
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
          } catch (err) {
            stepSpan.recordException(err as Error);
            stepSpan.setStatus({ code: 2, message: errorMessage(err) });
            throw err;
          } finally {
            stepSpan.end();
            await recordUsage(this.opts.model, 'assistant', usageSamples);
          }

          if (await checkCancellation()) throw new DOMException('cancelled', 'AbortError');

          if (text.length > 0 || reasoningText.length > 0) {
            const phase = toolCalls.length === 0 ? ('final' as const) : ('progress' as const);
            const citationList =
              phase === 'final' && text.trim().length > 0
                ? await answerGrounding(
                    await store.load(sessionId),
                    promptSeq,
                    sessionId,
                    this.opts.spill?.store,
                    signal,
                  )
                : undefined;
            await store.append(
              sessionId,
              [
                {
                  ...meta(),
                  type: 'message/assistant',
                  surfaceOp: 'append',
                  phase,
                  ...(citationList?.length ? { citationList } : {}),
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
              ],
              appendOpts,
            );
            if (text.length > 0) {
              sink.emit({
                type: 'message/assistant',
                content: text,
                phase,
                ...(citationList?.length ? { citationList } : {}),
              });
            }
          }

          if (toolCalls.length === 0) {
            break; // model is done — turn complete
          }

          if (concluding) {
            reason = 'error';
            detail = `step limit (${this.maxSteps}) reached`;
            break;
          }

          // Tool scheduling (design.md §6.3): consecutive parallel-class calls
          // run in a rolling pool; an 'exclusive' call forms a wave of its own.
          // tool/call and tool/result events are ALWAYS committed in strict
          // model-output order so replay stays deterministic.
          const waves: ToolCall[][] = [];
          let pending: ToolCall[] = [];
          for (const call of toolCalls) {
            if (call.name === 'browser' || tools.concurrencyOf(call.name) === 'exclusive') {
              if (pending.length > 0) {
                waves.push(pending);
                pending = [];
              }
              waves.push([call]);
            } else {
              pending.push(call);
            }
          }
          if (pending.length > 0) {
            waves.push(pending);
          }

          let browserFailed = false;
          let browserCalls = 0;
          for (const wave of waves) {
            throwIfAborted();
            await store.append(
              sessionId,
              wave.map((call) => ({
                ...meta(),
                type: 'tool/call' as const,
                callId: call.id,
                name: call.name,
                args: call.args,
              })),
              appendOpts,
            );
            for (const call of wave) {
              sink.emit({ type: 'tool/call', call: { ...call, args: call.args } });
            }

            // M3 permission gate (docs/design.md §12.2): 'denied' and rejected
            // 'ask' calls are resolved inline (isError results, model order
            // preserved); only allowed calls reach the execution pool.
            const presolved = new Map<string, ToolResult>();
            const executable: ToolCall[] = [];
            for (const call of wave) {
              if (
                call.name === 'browser' &&
                (browserFailed || ++browserCalls > BROWSER_LIMITS.callsPerStep)
              ) {
                presolved.set(call.id, {
                  isError: true,
                  value: {
                    kind: 'browser-error-v1',
                    code: 'NOT_EXECUTED',
                    operation: 'browser',
                    effect: 'none',
                    message:
                      'An earlier browser operation failed or the step call limit was reached. Inspect its result before proceeding.',
                  },
                });
                continue;
              }
              let decision = gate?.decide(call) ?? 'allowed';
              if (decision === 'ask' && call.name === 'bash') {
                const commandValue = (call.args as { command?: unknown } | null)?.command;
                const command = typeof commandValue === 'string' ? commandValue : undefined;
                if (!bashReferencesSensitiveFile(command)) {
                  const grants = (await store.load(sessionId)).filter(
                    (event) => event.type === 'approval/command_granted',
                  );
                  if (
                    matchesCommandPrefix(
                      command,
                      grants.map((event) => event.prefix),
                    )
                  )
                    decision = 'allowed';
                }
              }
              if (decision === 'denied') {
                presolved.set(call.id, {
                  value: {
                    message: `tool '${call.name}' is denied by the session permission policy`,
                  },
                  isError: true,
                });
              } else if (decision === 'ask') {
                const outcome = await this.gateCall(
                  sessionId,
                  call,
                  preview(call.args),
                  sink,
                  appendOpts,
                  signal,
                );
                if (outcome === 'rejected') {
                  presolved.set(call.id, {
                    value: { message: `tool '${call.name}' was rejected by the user` },
                    isError: true,
                  });
                } else {
                  executable.push(call);
                }
              } else {
                executable.push(call);
              }
            }

            const executed = new Map<string, ToolResult>();
            if (executable.length > 0) {
              const pooled = await this.runWave(
                executable,
                (call) => this.executeTool(call, { ...ctx, permissionGranted: true }, tools),
                throwIfAborted,
              );
              for (const [i, call] of executable.entries()) {
                executed.set(call.id, pooled[i]!);
              }
            }

            const results = wave.map((call) => presolved.get(call.id) ?? executed.get(call.id)!);
            if (wave.some((call, i) => call.name === 'browser' && results[i]!.isError))
              browserFailed = true;

            // M4 spill (docs/design.md §7): oversized results are stored in the
            // BlobStore and only a reference + preview hits the append-only log.
            const stored = await Promise.all(
              wave.map(async (call, i) => {
                const result = results[i]!;
                return this.spillIfLarge(sessionId, call, result);
              }),
            );

            await store.append(
              sessionId,
              wave.map((call, i) => {
                const result = stored[i]!;
                return {
                  ...meta(),
                  type: 'tool/result' as const,
                  callId: call.id,
                  value: result.value,
                  isError: result.isError,
                };
              }),
              appendOpts,
            );
            for (const [i, call] of wave.entries()) {
              sink.emit({
                type: 'tool/result',
                callId: call.id,
                name: call.name,
                result: stored[i]!,
              });
            }
          }

          // M4 context pressure: compact between steps so the NEXT request sees
          // a bounded surface (docs/design.md §6.1 "上下文压力/溢出 → 触发
          // compaction"). No-op when under budget.
          if (this.opts.context) {
            await this.opts.context.compact(sessionId, {
              signal,
              appendOpts,
              sink,
              beforeModelCall: async () => {
                const denied = this.opts.usage && tenantId ? await this.checkQuota(tenantId) : null;
                if (denied) throw new Error(denied);
              },
              recordUsage: (model, samples) => recordUsage(model, 'compaction', samples),
            });
          }
        }
      } catch (err) {
        if (signal?.aborted || isAbortError(err)) {
          reason = 'aborted';
        } else {
          reason = 'error';
          detail = errorMessage(err);
        }
      }

      await store.append(
        sessionId,
        [
          {
            ...meta(),
            type: 'turn/end',
            reason,
            ...(detail !== undefined ? { detail } : {}),
          },
        ],
        appendOpts,
      );
      sink.emit({ type: 'turn/end', reason, ...(detail !== undefined ? { detail } : {}) });

      return { reason, steps };
    } finally {
      // M5 OTel turn metrics (design.md §17): outcome + cost of the turn.
      turnSpan.setAttributes({
        'trinity.turn_steps': steps,
        'trinity.turn_reason': reason,
      });
      if (reason === 'error') {
        turnSpan.setStatus({ code: 2, message: detail ?? 'turn error' });
      }
      turnSpan.end();
      turnDuration.record(Date.now() - turnStartedAt, {
        'trinity.model': this.opts.model,
        'trinity.turn_reason': reason,
      });
      turnSteps.record(steps);
    }
  }

  /**
   * M5 quota check across the configured calendar windows (hour/day/month,
   * docs/design.md §17). Returns a user-facing denial message, or null when
   * the tenant is within every configured limit (and when no limit is
   * configured at all). Fail-closed: a store error denies the request.
   */
  private async checkQuota(tenantId: string): Promise<string | null> {
    const usage = this.opts.usage!;
    const labels: [QuotaWindow, keyof Awaited<ReturnType<UsagePort['quotaOf']>>][] = [
      ['hour', 'hourlyTokens'],
      ['day', 'dailyTokens'],
      ['month', 'monthlyTokens'],
    ];
    let quota: Awaited<ReturnType<UsagePort['quotaOf']>>;
    try {
      quota = await usage.quotaOf(tenantId);
    } catch (err) {
      console.error('[CoreAgentLoop] quota read failed (denying)', err);
      return 'model quota temporarily unavailable (fail-closed); try again later';
    }
    const now = new Date();
    for (const [window, field] of labels) {
      const limit = quota[field];
      if (limit === undefined) continue;
      let used: number;
      try {
        used = await usage.usageSince(tenantId, windowStart(window, now));
      } catch (err) {
        console.error('[CoreAgentLoop] quota usage read failed (denying)', err);
        return 'model quota temporarily unavailable (fail-closed); try again later';
      }
      if (used >= limit) {
        return (
          `model quota exceeded for this ${window} (used ${used.toLocaleString()} of ` +
          `${limit.toLocaleString()} tokens). Contact your administrator to raise the quota.`
        );
      }
    }
    return null;
  }

  /**
   * Spill one tool result when it exceeds the threshold (M4, docs/design.md
   * §7). Best-effort: a BlobStore failure keeps the full value in the log
   * rather than failing the turn (spill is an optimization, never a gate).
   */
  private async spillIfLarge(
    sessionId: string,
    call: ToolCall,
    result: ToolResult,
  ): Promise<ToolResult> {
    const spill = this.opts.spill;
    if (!spill || call.name === 'skill' || call.name === 'browser') return result;
    let serialized: string;
    try {
      serialized = typeof result.value === 'string' ? result.value : JSON.stringify(result.value);
    } catch {
      return result;
    }
    const threshold = spill.thresholdBytes ?? DEFAULT_SPILL_THRESHOLD_BYTES;
    if (serialized.length <= threshold) return result;
    try {
      const blob = await spill.store.put(
        `spill/${sessionId}/${call.id}.json`,
        new TextEncoder().encode(serialized),
        { mimeType: 'application/json' },
      );
      return {
        value: {
          spilled: blob.uri,
          bytes: serialized.length,
          preview: serialized.slice(0, 500),
        },
        isError: result.isError,
      };
    } catch (err) {
      console.error('[CoreAgentLoop] spill failed, logging full value', err);
      return result;
    }
  }

  /**
   * One human-gating round trip (docs/design.md §12.2): the request and the
   * outcome are BOTH appended to the event log (审批留痕) and emitted on the
   * sink so connected UIs can render the pending/decided states. Fail-closed:
   * a missing approval channel or a failed request resolves to 'rejected'.
   */
  private async gateCall(
    sessionId: string,
    call: ToolCall,
    argsPreview: string,
    sink: EventSink,
    appendOpts: { actor?: string } | undefined,
    signal: AbortSignal | undefined,
  ): Promise<'allowed' | 'rejected'> {
    const requester = this.opts.approvals;
    const approvalId = newId();
    // M5 OTel: approval latency (docs/design.md §17 审批延迟).
    const approvalStartedAt = Date.now();

    // Durable trail (secondary to the event log; best-effort by design).
    try {
      await this.opts.approvalStore?.request({
        id: approvalId,
        sessionId,
        toolCallId: call.id,
        toolName: call.name,
        argsPreview,
        outcome: null,
        decidedBy: null,
        createdAt: new Date().toISOString(),
        decidedAt: null,
      });
    } catch (err) {
      console.error('[CoreAgentLoop] approval trail insert failed', err);
    }

    await this.opts.store.append(
      sessionId,
      [
        {
          ...meta(),
          type: 'approval/requested',
          approvalId,
          toolCallId: call.id,
          toolName: call.name,
          argsPreview,
        },
      ],
      appendOpts,
    );
    sink.emit({ type: 'approval-requested', approvalId, call: { ...call }, argsPreview });

    let outcome: 'allowed' | 'rejected';
    let decidedBy: string;
    if (!requester) {
      // Fail-closed (§12.2): no approval channel ⇒ the gate itself rejects,
      // but the gating still leaves its trail in the log.
      outcome = 'rejected';
      decidedBy = 'system';
    } else
      try {
        // Race against the turn signal so a requester that ignores signals
        // cannot wedge the turn (AGENTS.md §4.2).
        let onAbort!: () => void;
        const abortRace = new Promise<never>((_resolve, reject) => {
          onAbort = () => reject(new DOMException('aborted', 'AbortError'));
        });
        if (signal) signal.addEventListener('abort', onAbort, { once: true });
        try {
          const reply = await Promise.race([
            requester.request(
              {
                sessionId,
                approvalId,
                toolCallId: call.id,
                toolName: call.name,
                argsPreview,
              },
              signal,
            ),
            abortRace,
          ]);
          outcome = reply.outcome;
          decidedBy = reply.decidedBy;
        } finally {
          signal?.removeEventListener('abort', onAbort);
        }
      } catch (err) {
        if (isAbortError(err)) throw err; // turn cancelled — propagate
        outcome = 'rejected';
        decidedBy = 'system';
      }

    await this.opts.store.append(
      sessionId,
      [
        {
          ...meta(),
          type: 'approval/resolved',
          approvalId,
          outcome,
          decidedBy,
        },
      ],
      appendOpts,
    );
    try {
      await this.opts.approvalStore?.resolve(approvalId, outcome, decidedBy);
    } catch (err) {
      console.error('[CoreAgentLoop] approval trail resolve failed', err);
    }
    sink.emit({ type: 'approval-resolved', approvalId, callId: call.id, outcome, decidedBy });
    approvalDuration.record(Date.now() - approvalStartedAt, {
      'trinity.tool': call.name,
      'trinity.approval_outcome': outcome,
    });
    return outcome;
  }

  /**
   * One tool execution inside its own OTel span + outcome counter
   * (docs/design.md §17: 工具成功率). Errors stay ToolResults (isError) at
   * the registry layer; here we only observe.
   */
  private async executeTool(
    call: ToolCall,
    ctx: {
      sessionId: string;
      workspaceRoot: string;
      signal?: AbortSignal;
      permissionGranted?: boolean;
    },
    tools: ToolRegistry,
  ): Promise<ToolResult> {
    const span = tracer.startSpan('trinity.tool', {
      attributes: { 'trinity.tool': call.name },
    });
    const startedAt = Date.now();
    try {
      const result = await tools.execute(call, ctx);
      toolCounter.add(1, {
        'trinity.tool': call.name,
        'trinity.tool_status': result.isError ? 'error' : 'ok',
      });
      if (result.isError) {
        span.setStatus({ code: 2, message: 'tool returned isError' });
      }
      return result;
    } catch (err) {
      toolCounter.add(1, { 'trinity.tool': call.name, 'trinity.tool_status': 'error' });
      span.recordException(err as Error);
      span.setStatus({ code: 2, message: errorMessage(err) });
      throw err;
    } finally {
      span.setAttribute('trinity.tool_duration_ms', Date.now() - startedAt);
      span.end();
    }
  }

  /**
   * Rolling pool over one wave: start calls in order, at most `maxParallel`
   * in flight; results land in call order. Aborts throw out of the pool and
   * in-flight executions see the same AbortSignal via the tool context.
   */
  private async runWave(
    wave: ToolCall[],
    execute: (call: ToolCall) => Promise<ToolResult>,
    throwIfAborted: () => void,
  ): Promise<ToolResult[]> {
    const results: ToolResult[] = new Array(wave.length);
    let next = 0;
    const workers = Array.from({ length: Math.min(this.maxParallel, wave.length) }, async () => {
      while (next < wave.length) {
        throwIfAborted();
        const index = next++;
        results[index] = await execute(wave[index]!);
      }
    });
    await Promise.all(workers);
    return results;
  }
}
