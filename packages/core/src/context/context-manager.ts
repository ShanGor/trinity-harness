import type {
  AppendOptions,
  EventSink,
  LLMPort,
  SessionEvent,
  SessionStore,
} from '@trinity-harness/contracts';
import { compactionRanges, isCompacted } from '@trinity-harness/contracts';

import { heuristicEstimator, type TokenEstimator } from './estimate-tokens.js';
import { toModelMessages } from '../loop/to-model-messages.js';

/**
 * Context Manager (docs/design.md §5.1, §7): context-pressure detection +
 * LLM summarization + surface range replacement. Compaction NEVER deletes
 * history — it appends one `compaction/summary` log event whose
 * `[fromSeq, toSeq]` range the projection replaces with the summary (dsh
 * `surfaceOp: replace` idea, PG-backed).
 */

export interface ContextManagerOptions {
  llm: LLMPort;
  /** Summarizer model (e.g. a cheap/fast model id known to the gateway). */
  model: string;
  store: SessionStore;
  /** Pressure threshold: compact when the projected context exceeds this. */
  maxTokens: number;
  /** Retained tail: compaction stops while the recent context is <= this. */
  keepTokens: number;
  /** Injectable estimator (tests; default = deterministic heuristic). */
  estimate?: TokenEstimator | undefined;
}

export interface CompactResult {
  compacted: boolean;
  fromSeq?: number;
  toSeq?: number;
  tokensBefore: number;
  tokensAfter?: number;
  summary?: string;
}

/** One user message plus everything up to the next user message. */
interface ExchangeGroup {
  fromSeq: number;
  toSeq: number;
  approxTokens: number;
}

function eventApproxTokens(event: SessionEvent): number {
  // JSON payload length / 4 — the same scale as the text heuristic.
  try {
    return Math.ceil(JSON.stringify(event).length / 4);
  } catch {
    return 16;
  }
}

/**
 * Splits the log into exchange groups starting at each `message/user`.
 * Everything before the first user message (session/created, …) is never
 * compacted. A `compaction/summary` event is a HARD boundary: it closes the
 * current group, and all events at or before it are dead surface — later
 * ranges must start strictly after it, so compaction intervals never overlap.
 */
export function exchangeGroups(events: readonly SessionEvent[]): ExchangeGroup[] {
  const groups: ExchangeGroup[] = [];
  // Dead surface = every event inside an applied compaction range, plus the
  // compaction markers themselves. Grouping runs over LIVE events only, so
  // a new range can never overlap a previous one.
  const ranges = compactionRanges(events);
  let current: ExchangeGroup | null = null;
  events.forEach((event, i) => {
    const seq = i + 1;
    if (event.type === 'compaction/summary' || isCompacted(seq, ranges)) return;
    if (event.type === 'message/user') {
      if (current) groups.push(current);
      current = { fromSeq: seq, toSeq: seq, approxTokens: 0 };
    }
    if (current) {
      current.toSeq = seq;
      current.approxTokens += eventApproxTokens(event);
    }
  });
  if (current) groups.push(current);
  return groups;
}

export class ContextManager {
  private readonly estimate: TokenEstimator;

  constructor(private readonly opts: ContextManagerOptions) {
    this.estimate = opts.estimate ?? heuristicEstimator;
  }

  /** Current projected context size in tokens (compaction-aware fold). */
  async pressure(sessionId: string, system?: string): Promise<number> {
    const events = await this.opts.store.load(sessionId);
    return this.estimate(toModelMessages(events), system);
  }

  /**
   * Compact when over budget: drop whole EXCHANGES from the front (never the
   * most recent user message — it may be the in-flight prompt), summarize
   * them with the LLM, append `compaction/summary`. Boundary snapping to
   * whole exchanges guarantees tool/call + tool/result pairs are never split
   * (docs/design.md §7 "摘要边界吸附在 tool call/result 配对处").
   */
  async compact(
    sessionId: string,
    extras?: {
      signal?: AbortSignal | undefined;
      appendOpts?: AppendOptions | undefined;
      sink?: EventSink;
    },
  ): Promise<CompactResult> {
    const { store } = this.opts;
    const events = await store.load(sessionId);
    const tokensBefore = this.estimate(toModelMessages(events));
    if (tokensBefore <= this.opts.maxTokens) {
      return { compacted: false, tokensBefore };
    }

    const groups = exchangeGroups(events);
    if (groups.length < 2) {
      // Never compact away the only exchange (it ends with the latest prompt).
      return { compacted: false, tokensBefore };
    }

    // Oldest groups first; stop before the tail we must keep. The LAST group
    // is always retained (it ends with the most recent user message).
    const budget = Math.max(tokensBefore - this.opts.keepTokens, 0);
    let toSeq: number | null = null;
    let compactedTokens = 0;
    for (const group of groups.slice(0, -1)) {
      if (compactedTokens + group.approxTokens > budget) break;
      compactedTokens += group.approxTokens;
      toSeq = group.toSeq;
    }
    if (toSeq === null) {
      // Even the oldest group would blow the retained tail — do nothing
      // rather than churn (the turn will hit the model's own limit instead).
      return { compacted: false, tokensBefore };
    }
    const fromSeq = groups[0]!.fromSeq;

    // Summarize the dropped range with the LLM.
    const dropped = toModelMessages(events.slice(fromSeq - 1, toSeq));
    const summary = await this.summarize(dropped, extras?.signal);

    await store.append(
      sessionId,
      [
        {
          eventId: crypto.randomUUID(),
          at: new Date().toISOString(),
          type: 'compaction/summary',
          fromSeq,
          toSeq,
          summary,
        },
      ],
      extras?.appendOpts,
    );
    extras?.sink?.emit({ type: 'context/compacted', fromSeq, toSeq });

    const eventsAfter = await store.load(sessionId);
    return {
      compacted: true,
      fromSeq,
      toSeq,
      tokensBefore,
      tokensAfter: this.estimate(toModelMessages(eventsAfter)),
      summary,
    };
  }

  /** One non-streaming summarize pass over the dropped range. */
  private async summarize(
    dropped: ReturnType<typeof toModelMessages>,
    signal: AbortSignal | undefined,
  ): Promise<string> {
    const transcript = dropped
      .map((m) => {
        const head =
          m.role === 'tool' ? `tool-result(${m.toolName ?? m.toolCallId ?? ''})` : m.role;
        const calls =
          m.toolCalls
            ?.map((tc) => `\n  → tool-call ${tc.name}(${JSON.stringify(tc.args).slice(0, 500)})`)
            .join('') ?? '';
        return `### ${head}\n${m.content}${calls}`;
      })
      .join('\n\n');
    const chunks = await llmStreamAll(this.opts.llm, {
      model: this.opts.model,
      system:
        'You compact conversation histories for a coding agent. Summarize the excerpt: ' +
        'key decisions, files read/written, commands run and their outcomes, errors hit, ' +
        'and the current task state. Be dense and factual; the summary replaces the ' +
        'excerpt in the agent context.',
      messages: [
        {
          role: 'user',
          content: `Condense the following conversation excerpt into a compact summary:\n\n${transcript}`,
        },
      ],
      tools: [],
      signal,
    });
    const text = chunks.join('');
    if (text.trim().length === 0) {
      // Never write an empty summary — a failed summarization must still
      // leave the surface coherent (fail-closed content, not an empty range).
      return '(compaction: the original conversation was condensed here, but the summarizer produced no output)';
    }
    return text;
  }
}

async function llmStreamAll(
  llm: LLMPort,
  req: Parameters<LLMPort['stream']>[0],
): Promise<string[]> {
  const stream = await llm.stream(req);
  const texts: string[] = [];
  for await (const chunk of stream) {
    if (chunk.kind === 'text-delta') texts.push(chunk.text);
    else if (chunk.kind === 'finish' && chunk.reason === 'error') {
      throw new Error('compaction summarizer stream finished with an error');
    }
  }
  return texts;
}
