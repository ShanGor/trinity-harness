/**
 * Token estimation (docs/design.md §17 配额 / §5.1 Context Manager).
 *
 * No tokenizer is bundled offline, so the default estimator uses a
 * deterministic chars/≈4 heuristic — good enough for context-pressure
 * decisions, and fully injectable so tests never depend on real tokenizers.
 */

import type { ConversationMessage } from '@trinity-harness/contracts';

export type TokenEstimator = (messages: readonly ConversationMessage[], system?: string) => number;

const CHARS_PER_TOKEN = 4;

export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** Default heuristic estimator over model-conversation messages. */
export const heuristicEstimator: TokenEstimator = (messages, system) => {
  let total = system !== undefined ? estimateTextTokens(system) : 0;
  for (const m of messages) {
    total += estimateTextTokens(m.content);
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
