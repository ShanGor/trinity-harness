/**
 * Token estimation (docs/design.md §17 配额 / §5.1 Context Manager).
 *
 * No tokenizer is bundled offline, so the default estimator uses a
 * deterministic chars/≈4 heuristic — good enough for context-pressure
 * decisions, and fully injectable so tests never depend on real tokenizers.
 */

import type { ConversationMessage } from '@trinity-harness/contracts';
import type { LLMRequest, SessionEvent } from '@trinity-harness/contracts';

export type TokenEstimator = (messages: readonly ConversationMessage[], system?: string) => number;

const CHARS_PER_TOKEN = 4;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function estimateRequestTokens(
  request: Pick<LLMRequest, 'messages' | 'system' | 'tools' | 'estimatedInputTokens'>,
): number {
  return Math.max(
    request.estimatedInputTokens ?? 0,
    heuristicEstimator(request.messages, request.system) +
      estimateTextTokens(JSON.stringify(request.tools)) +
      request.messages.length * 8,
  );
}

/** Ignore old measurements after checkpoints, closed turns, or model changes. */
export function observedInputAdjustment(events: readonly SessionEvent[], model: string): number {
  const boundary = events.findLastIndex(
    (event) => event.type === 'compaction/summary' || event.type === 'turn/end',
  );
  const usage = events
    .slice(boundary + 1)
    .findLast(
      (event) =>
        event.type === 'model/usage' &&
        event.usage.purpose === 'assistant' &&
        event.usage.model === model,
    );
  if (usage?.type !== 'model/usage' || usage.usage.tokens.inputTokens === undefined) return 0;
  const request = events.find(
    (event) => event.type === 'task/request' && event.requestId === usage.usage.requestId,
  );
  return request?.type === 'task/request'
    ? Math.max(0, usage.usage.tokens.inputTokens - request.estimatedInputTokens)
    : 0;
}

/** Default heuristic estimator over model-conversation messages. */
export const heuristicEstimator: TokenEstimator = (messages, system) => {
  let total = system !== undefined ? estimateTextTokens(system) : 0;
  for (const m of messages) {
    total += estimateTextTokens(m.content) + (m.context ? 32 : 0);
    for (const r of m.reasoning ?? []) {
      total += estimateTextTokens(r.text);
    }
    for (const b of m.blocks ?? []) {
      // Images/files cost provider-side tokens by size class, not chars.
      total +=
        b.kind === 'image' ? 1_600 : b.kind === 'file' ? 800 : estimateTextTokens(b.text ?? '');
    }
    for (const tc of m.toolCalls ?? []) {
      total += estimateTextTokens(JSON.stringify(tc.args));
    }
  }
  return total;
};
