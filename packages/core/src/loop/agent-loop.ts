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
  TaskExecutionPort,
  TaskBudgetScope,
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
import { taskVerification, verificationToolAllowed } from './task-verification.js';
import { estimateRequestTokens, observedInputAdjustment } from '../context/estimate-tokens.js';
import { setTimeout as delay } from 'node:timers/promises';
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
  execution?: TaskExecutionPort | undefined;
  verification?: boolean | undefined;
  maxContextTokens?: number | undefined;
  maxOutputTokens?: number | undefined;
  maxRetries?: number | undefined;
  /** Injected clock/backoff for deterministic recovery tests. */
  wait?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
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

export function classifyModelFailure(error: unknown): 'overflow' | 'retry' | 'fatal' {
  const value = error as {
    statusCode?: unknown;
    code?: unknown;
    isRetryable?: unknown;
    cause?: unknown;
  } | null;
  const message = errorMessage(error).toLowerCase();
  if (
    /(context[_ -]?(length|window)|maximum context|too many tokens|prompt.{0,30}too long)/.test(
      message,
    )
  )
    return 'overflow';
  if (
    value?.isRetryable === true ||
    [408, 429, 500, 502, 503, 504].includes(Number(value?.statusCode)) ||
    ['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED'].includes(String(value?.code)) ||
    /stream interrupted|socket closed|fetch failed/.test(message)
  )
    return 'retry';
  if (value?.cause && value.cause !== error) return classifyModelFailure(value.cause);
  return 'fatal';
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
    this.maxSteps = turnStepBudgetSchema.parse(opts.maxSteps) ?? Infinity;
    this.maxParallel = Math.max(1, opts.maxParallelTools ?? DEFAULT_MAX_PARALLEL_TOOLS);
  }

  async run(
    sessionId: string,
    prompt: string,
    sink: EventSink,
    runOpts?: RunTurnOptions,
  ): Promise<TurnOutcome> {
    let signal = runOpts?.signal;
    let taskBudget: TaskBudgetScope | undefined = runOpts?.taskBudget;
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
    let stepLimit = this.maxSteps;
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
        if (
          !(await store.load(sessionId)).some(
            (event) => event.type === 'model/usage' && event.usage.requestId === usage.requestId,
          )
        )
          await store.append(sessionId, [{ ...meta(), type: 'model/usage', usage }], appendOpts);
        sink.emit({ type: 'model/usage', usage });
      };
      ctx.recordUsage = (usage) => persistUsage({ ...usage, promptId, purpose: 'subagent' });
      const recordUsage = async (
        model: string,
        purpose: ModelUsage['purpose'],
        samples: TokenUsage[],
        requestId = newId(),
      ): Promise<void> => {
        const tokens = normalizeTokenUsage(sumTokenUsage(samples));
        const entry: ModelUsage = {
          requestId,
          promptId,
          model,
          purpose: runOpts?.taskBudget ? 'subagent' : purpose,
          tokens,
          ...priceUsage(model, tokens, this.opts.pricing ?? {}),
        };
        await taskBudget?.record(entry);
        await persistUsage(entry);
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

      let lane: 'work' | 'verification' | 'final' = 'work';
      const requestStream = async (
        request: LLMRequest,
        purpose: ModelUsage['purpose'],
      ): Promise<AsyncIterable<StreamChunk>> => {
        if (await checkCancellation()) throw new DOMException('cancelled', 'AbortError');
        if (signal?.aborted) signal.throwIfAborted();
        const denied = this.opts.usage && tenantId ? await this.checkQuota(tenantId) : null;
        if (denied) throw new Error(denied);
        const effectivePurpose = runOpts?.taskBudget ? 'subagent' : purpose;
        const requestId =
          (await taskBudget?.admit(
            request,
            effectivePurpose,
            purpose === 'compaction' ? 'work' : lane,
          )) ?? newId();
        let stream: AsyncIterable<StreamChunk>;
        try {
          stream = await llm.stream(request);
        } catch (err) {
          await recordUsage(request.model, purpose, [], requestId);
          throw err;
        }
        const samples: TokenUsage[] = [];
        return (async function* () {
          try {
            for await (const chunk of stream) {
              if (chunk.kind === 'usage') samples.push(chunk);
              yield chunk;
            }
          } finally {
            await recordUsage(request.model, purpose, samples, requestId);
          }
        })();
      };
      const recover = async (
        kind: 'retry' | 'overflow' | 'length' | 'interrupted' | 'verification',
        advice: string,
        limit: number,
      ): Promise<boolean> => {
        const events = await store.load(sessionId);
        const attempts = events
          .slice(promptSeq)
          .filter(
            (event) =>
              event.type === 'task/recovery' && event.promptId === promptId && event.kind === kind,
          ).length;
        if (attempts >= limit || steps >= stepLimit) return false;
        await store.append(
          sessionId,
          [{ ...meta(), type: 'task/recovery', promptId, kind, advice }],
          appendOpts,
        );
        if (kind === 'retry')
          await (
            this.opts.wait ??
            (async (ms, abort) => {
              await delay(ms, undefined, { signal: abort });
            })
          )(Math.min(1000 * 2 ** attempts, 8000), signal);
        return true;
      };
      const compact = async (force = false, system?: string): Promise<boolean> => {
        if (!this.opts.context) return false;
        try {
          const result = await this.opts.context.compact(sessionId, {
            signal,
            appendOpts,
            sink,
            force,
            model: this.opts.model,
            ...(system ? { system } : {}),
            tools: tools.schemas(),
            llm: { stream: (request) => requestStream(request, 'compaction') },
          });
          return result.compacted;
        } catch (error) {
          // Preserve the parent conclusion allowance. Quota/security failures still propagate.
          if ((error as { code?: unknown } | null)?.code === 'TASK_BUDGET_EXHAUSTED') return false;
          throw error;
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
        if (reason === 'completed') {
          taskBudget ??= await this.opts.execution?.open(sessionId, promptId, signal, actor);
          if (taskBudget) {
            stepLimit = Math.min(stepLimit, taskBudget.maxSteps ?? Infinity);
            signal = signal ? AbortSignal.any([signal, taskBudget.signal]) : taskBudget.signal;
            ctx.signal = signal;
            ctx.taskBudget = taskBudget;
            steps = (await store.load(sessionId)).filter(
              (event) => event.type === 'task/step' && event.promptId === promptId,
            ).length;
          }
        }
        // `promptGated` ⇒ skip the model loop entirely; turn/end still lands.
        while (reason === 'completed') {
          throwIfAborted();
          if (await checkCancellation()) throw new DOMException('cancelled', 'AbortError');
          // Reached only when the previous step ended with tool calls: the cap
          // counts completed model requests, so a turn finishing exactly on the
          // limit still reports 'completed'.
          if (steps >= stepLimit) {
            reason = 'error';
            detail = `step limit (${stepLimit}) reached`;
            break;
          }
          steps += 1;

          // M4 context pressure: compact BEFORE the request so history entering
          // a new turn is bounded, and again between steps after tool waves
          // (docs/design.md §6.1 "上下文压力/溢出 → 触发 compaction"). No-op
          // when under budget.
          await compact(false, this.opts.systemPrompt);

          await this.opts.skills?.prepare({
            sessionId,
            workspaceRoot: this.opts.workspaceRoot,
            prompt: steps === 1 ? prompt : undefined,
            policy: runOpts?.policy,
            signal,
            appendOpts,
          });
          let history = await store.load(sessionId);
          const advice = progressGuidance(history, promptSeq, steps, stepLimit, researchAvailable);
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
          const planned = history.some(
            (event) => event.type === 'task/plan' && event.promptId === promptId,
          );
          const verification = taskVerification(history, promptId);
          const budgetConcluding =
            (await taskBudget?.shouldConclude({
              model: this.opts.model,
              messages: toModelMessages(history),
              tools: tools.schemas(),
              system: this.opts.systemPrompt,
              maxOutputTokens: this.opts.maxOutputTokens ?? 8192,
            })) ?? false;
          const budgetFinalizing =
            (await taskBudget?.shouldFinalize({
              model: this.opts.model,
              messages: toModelMessages(history),
              system: this.opts.systemPrompt,
              tools: tools.schemas(),
              maxOutputTokens: this.opts.maxOutputTokens ?? 8192,
            })) ?? false;
          const verifying =
            planned &&
            verification.status !== 'verified' &&
            (steps >= stepLimit - 2 || budgetConcluding);
          const concluding =
            steps === stepLimit ||
            budgetFinalizing ||
            browserBudgetExhausted ||
            diagnosticsExhausted ||
            (budgetConcluding && !verifying);
          lane = concluding ? 'final' : verifying ? 'verification' : 'work';
          const conclusion = concluding
            ? 'This is the final step of the turn. Produce your final answer now using the evidence already collected. State uncertainties and incomplete work explicitly; do not claim success without evidence. Cite retrieved sources when relevant. Do not call tools.'
            : undefined;
          const system = [
            this.opts.systemPrompt,
            augmented,
            this.opts.verification
              ? 'Before substantive tool work, call task with operation plan to declare checks covering every user requirement, including required tests/builds. Execute checks through normal tools, then call task verify with their current successful call IDs. After changes rerun affected checks. Do not remove requirements to claim completion. A verified checklist is evidence of the declared checks only. If work or verification is incomplete, say so explicitly.'
              : undefined,
            verifying
              ? 'Use the reserved verification allowance to run pending checks and record evidence. Do not start new implementation or delegate more work.'
              : undefined,
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
            tools: concluding
              ? []
              : verifying
                ? tools
                    .schemas()
                    .filter(
                      (schema) =>
                        !['write_file', 'edit_file', 'subagent', 'lsp_rename'].includes(
                          schema.name,
                        ),
                    )
                : tools.schemas(),
            signal,
            maxOutputTokens: Math.min(
              this.opts.maxOutputTokens ?? 8192,
              Math.max(
                1,
                (this.opts.maxContextTokens ?? 200_000) -
                  Math.ceil(
                    estimateRequestTokens({
                      messages: toModelMessages(history),
                      system,
                      tools: concluding ? [] : tools.schemas(),
                    }) * 1.15,
                  ),
              ),
            ),
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

          if (await compact(false, system)) {
            history = await store.load(sessionId);
            request.messages = toModelMessages(history);
          }
          request.estimatedInputTokens =
            estimateRequestTokens(request) + observedInputAdjustment(history, this.opts.model);
          const inputEstimate = Math.ceil(estimateRequestTokens(request) * 1.15);
          const room = (this.opts.maxContextTokens ?? 200_000) - inputEstimate;
          if (room < 1)
            throw new Error(
              'CONTEXT_TOO_LARGE: required prompt/instructions exceed the model window after compaction',
            );
          request.maxOutputTokens = Math.min(this.opts.maxOutputTokens ?? 8192, room);

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
          let text = '';
          let reasoningText = '';
          let reasoningSignature: string | undefined;
          const toolCalls: ToolCall[] = [];
          let finish: 'stop' | 'length' | 'error' | undefined;
          let failure: unknown;
          try {
            if (taskBudget)
              await store.append(
                sessionId,
                [{ ...meta(), type: 'task/step', promptId }],
                appendOpts,
              );
            const chunks = await requestStream(request, 'assistant');
            for await (const chunk of chunks) {
              throwIfAborted();
              if (chunk.kind === 'text-delta') {
                text += chunk.text;
                sink.emit({ type: 'text-delta', text: chunk.text });
              } else if (chunk.kind === 'reasoning-delta') {
                if (chunk.signature !== undefined) reasoningSignature = chunk.signature;
                reasoningText += chunk.text;
                if (chunk.text) sink.emit({ type: 'reasoning-delta', text: chunk.text });
              } else if (chunk.kind === 'tool-call') toolCalls.push(chunk.call);
              else if (chunk.kind === 'finish') {
                finish = chunk.reason;
                if (finish === 'error') throw new Error('LLM stream finished with an error');
              }
            }
            if (!finish) throw new Error('LLM stream interrupted before finish');
          } catch (err) {
            failure = err;
            stepSpan.recordException(err as Error);
            stepSpan.setStatus({ code: 2, message: errorMessage(err) });
          } finally {
            stepSpan.end();
          }
          if (failure !== undefined) {
            if (signal?.aborted || isAbortError(failure)) throw failure;
            // Never execute calls from an incomplete response, or replay side effects on retry.
            const classification = classifyModelFailure(failure);
            if (
              classification === 'overflow' &&
              !text &&
              !reasoningText &&
              (await recover(
                'overflow',
                'The provider rejected the context. A new checkpoint was requested; continue from retained evidence.',
                1,
              )) &&
              (await compact(true, system))
            )
              continue;
            if (
              classification === 'retry' &&
              !text &&
              !reasoningText &&
              !toolCalls.length &&
              (await recover(
                'retry',
                'The previous model request failed before output. Retry from the committed task state.',
                this.opts.maxRetries ?? 3,
              ))
            )
              continue;
            if (
              classification === 'retry' &&
              (text || reasoningText) &&
              !toolCalls.length &&
              (await recover(
                'interrupted',
                'The previous model response was interrupted. Continue from the recorded partial response without repeating it. Inspect state before retrying effects.',
                2,
              ))
            ) {
              await store.append(
                sessionId,
                [
                  {
                    ...meta(),
                    type: 'message/assistant',
                    surfaceOp: 'append',
                    phase: 'progress',
                    continuation: true,
                    content: [
                      { kind: 'text', text: text || '[Reasoning interrupted before an answer]' },
                    ],
                  },
                ],
                appendOpts,
              );
              continue;
            }
            throw failure;
          }

          if (await checkCancellation()) throw new DOMException('cancelled', 'AbortError');

          const truncated = finish === 'length';
          const needsVerification =
            this.opts.verification &&
            toolCalls.length === 0 &&
            !truncated &&
            (planned ||
              history
                .slice(promptSeq)
                .some((event) => event.type === 'tool/call' && event.name !== 'task'));
          const assessment = taskVerification(await store.load(sessionId), promptId);
          const rejectedCompletion = needsVerification && assessment.status !== 'verified';
          let repairCompletion = false;
          if (rejectedCompletion) {
            await store.append(
              sessionId,
              [{ ...meta(), type: 'task/assessment', promptId, ...assessment }],
              appendOpts,
            );
            if (!concluding)
              repairCompletion = await recover(
                'verification',
                `Completion is not verified. Complete the pending checks using task before the final answer: ${assessment.pending.join('; ').slice(0, 1400)}`,
                2,
              );
            if (!repairCompletion) {
              reason = 'error';
              detail = `Task incomplete: ${assessment.pending.join('; ').slice(0, 1400)}`;
              text = `Task verification is incomplete. ${assessment.pending.join('; ')}\n\n${text}`;
            }
          } else if (needsVerification)
            await store.append(
              sessionId,
              [{ ...meta(), type: 'task/assessment', promptId, ...assessment }],
              appendOpts,
            );

          if (toolCalls.length === 0 && !truncated && !repairCompletion && !rejectedCompletion) {
            const prior = (await store.load(sessionId)).slice(promptSeq);
            const lastCall = prior.findLastIndex((event) => event.type === 'tool/call');
            const prefix = prior
              .slice(lastCall + 1)
              .flatMap((event) =>
                event.type === 'message/assistant' && event.continuation
                  ? event.content.flatMap((block) => (block.kind === 'text' ? [block.text] : []))
                  : [],
              )
              .join('');
            text = prefix + text;
          }
          if (text.length > 0 || reasoningText.length > 0) {
            const phase =
              toolCalls.length === 0 && !truncated && !repairCompletion
                ? ('final' as const)
                : ('progress' as const);
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
                  ...(truncated ? { continuation: true } : {}),
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

          if (repairCompletion) continue;
          if (truncated) {
            // A truncated response cannot authorize tool execution.
            if (
              concluding ||
              !(await recover(
                'length',
                'The previous response hit its output limit. Continue without repeating content. Reissue any unexecuted tool calls with complete, smaller arguments.',
                2,
              ))
            ) {
              reason = 'error';
              detail = 'Response remains truncated; task completion is unverified';
              break;
            }
            continue;
          }
          if (toolCalls.length === 0) {
            break; // model is done — turn complete
          }

          if (concluding) {
            reason = 'error';
            detail = `step limit (${stepLimit}) reached`;
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
                verifying &&
                !verificationToolAllowed(await store.load(sessionId), promptId, call)
              ) {
                presolved.set(call.id, {
                  isError: true,
                  value: {
                    code: 'VERIFICATION_ONLY',
                    message:
                      'The reserved allowance permits declared verification commands and observations only; no new implementation or delegation.',
                  },
                });
                continue;
              }
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
        }
      } catch (err) {
        if (taskBudget?.signal.aborted && !runOpts?.signal?.aborted) {
          reason = 'error';
          detail = 'Task deadline reached; unfinished work remains';
        } else if (signal?.aborted || isAbortError(err)) {
          reason = 'aborted';
        } else {
          reason = 'error';
          detail = errorMessage(err);
        }
      }

      if (this.opts.verification || taskBudget) {
        const events = await store.load(sessionId);
        const assessment = taskVerification(events, promptId);
        if (reason !== 'completed') {
          assessment.status = 'incomplete';
          if (!assessment.pending.length)
            assessment.pending = ['Execution ended before a verified final answer.'];
        }
        const previous = events.findLast(
          (event) => event.type === 'task/assessment' && event.promptId === promptId,
        );
        if (
          previous?.type !== 'task/assessment' ||
          previous.status !== assessment.status ||
          JSON.stringify(previous.pending) !== JSON.stringify(assessment.pending)
        )
          await store.append(
            sessionId,
            [{ ...meta(), type: 'task/assessment', promptId, ...assessment }],
            appendOpts,
          );
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
      if (!runOpts?.taskBudget) taskBudget?.dispose();
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
          ...(call.name === 'bash' &&
          typeof (result.value as { exitCode?: unknown } | null)?.exitCode === 'number'
            ? { exitCode: (result.value as { exitCode: number }).exitCode }
            : {}),
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
    ctx: ToolContextInput,
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
