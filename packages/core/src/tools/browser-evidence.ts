import type { BlobStore, BrowserRange, SessionEvent } from '@trinity-harness/contracts';
import {
  browserDeliveries,
  exposedBrowserRange,
  loadBrowserObservation,
} from './browser-artifacts.js';

export interface ResolvedBrowserSource {
  observationId: string;
  blockId: string;
  start: number;
  end: number;
  url: string;
  quote: string;
  callId: string;
  evidenceSeq: number;
  artifactUri: string;
  capturedAt: string;
}

export class BrowserSourceError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'BrowserSourceError';
  }
}
/** Resolve only committed, current-turn exposure. A stored blob alone is insufficient. */
export async function resolveBrowserSource(
  source: { observationId: string; blockId: string; start?: number; end?: number },
  events: readonly SessionEvent[],
  promptSeq: number,
  sessionId: string,
  blobs: BlobStore,
  signal?: AbortSignal,
): Promise<ResolvedBrowserSource> {
  const observation = await loadBrowserObservation(
    blobs,
    events,
    sessionId,
    source.observationId,
    signal,
  );
  const block = observation.blocks.find((b) => b.id === source.blockId);
  if (!block) throw new BrowserSourceError('UNKNOWN_BLOCK', 'Unknown evidence block');
  const points = Array.from(block.text);
  const range: BrowserRange = {
    blockId: block.id,
    start: source.start ?? 0,
    end: source.end ?? points.length,
  };
  if (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 0 ||
    range.end <= range.start ||
    range.end > points.length
  )
    throw new BrowserSourceError('INVALID_RANGE', 'Invalid evidence range');
  const quote = points.slice(range.start, range.end).join('');
  if (quote.length > 600)
    throw new BrowserSourceError(
      'RANGE_TOO_LARGE',
      'Select a source range of at most 600 characters',
    );
  const deliveries = browserDeliveries(events, sessionId, promptSeq).filter(
    (d) => d.result.observationId === observation.observationId,
  );
  // Validate every credited range against the verified immutable canonical text.
  const valid = deliveries.filter((d) =>
    d.result.blocks.every((delivered) => {
      const original = observation.blocks.find((b) => b.id === delivered.id);
      return (
        original &&
        Array.from(original.text).slice(delivered.start, delivered.end).join('') ===
          delivered.text &&
        d.result.url === observation.url &&
        d.result.capturedAt === observation.capturedAt
      );
    }),
  );
  const last = valid.at(-1);
  if (
    !last ||
    !exposedBrowserRange({ ...last.result, receipt: valid.flatMap((d) => d.result.receipt) }, range)
  )
    throw new BrowserSourceError(
      'RANGE_NOT_EXPOSED',
      'Cited range was not exposed in a successful current-turn browser result',
    );
  const first = valid.find((d) =>
    d.result.receipt.some(
      (r) => r.blockId === range.blockId && r.end > range.start && r.start < range.end,
    ),
  )!;
  return {
    ...source,
    ...range,
    url: observation.url,
    quote,
    callId: first.callId,
    evidenceSeq: first.seq,
    artifactUri: last.result.artifactUri,
    capturedAt: observation.capturedAt,
  };
}

/** URL/quote input resolves to the same immutable, delivered ranges as explicit references. */
export async function resolveBrowserQuote(
  source: { url: string; quote: string; callId?: string },
  events: readonly SessionEvent[],
  promptSeq: number,
  sessionId: string,
  blobs: BlobStore,
  signal?: AbortSignal,
): Promise<ResolvedBrowserSource | null> {
  const deliveries = browserDeliveries(events, sessionId, promptSeq).filter(
    (delivery) =>
      delivery.result.url === source.url && (!source.callId || delivery.callId === source.callId),
  );
  // Escape each literal word; only whitespace differences are accepted.
  const pattern = source.quote
    .trim()
    .split(/\s+/u)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+');
  if (!pattern) return null;
  const observations = new Set(deliveries.map((delivery) => delivery.result.observationId));
  for (const observationId of [...observations].reverse()) {
    signal?.throwIfAborted();
    const observation = await loadBrowserObservation(
      blobs,
      events,
      sessionId,
      observationId,
      signal,
    );
    const matching = deliveries.filter(
      (delivery) => delivery.result.observationId === observationId,
    );
    for (const block of observation.blocks) {
      const ranges: BrowserRange[] = [];
      for (const receipt of matching
        .flatMap((delivery) => delivery.result.receipt)
        .filter((range) => range.blockId === block.id)
        .sort((a, b) => a.start - b.start)) {
        const previous = ranges.at(-1);
        if (previous && receipt.start <= previous.end)
          previous.end = Math.max(previous.end, receipt.end);
        else ranges.push({ ...receipt });
      }
      const points = Array.from(block.text);
      for (const exposed of ranges) {
        const text = points.slice(exposed.start, exposed.end).join('');
        const match = new RegExp(pattern, 'u').exec(text);
        if (!match) continue;
        const start = exposed.start + Array.from(text.slice(0, match.index)).length;
        const end = start + Array.from(match[0]).length;
        const range = { blockId: block.id, start, end };
        return resolveBrowserSource(
          { observationId, ...range },
          events,
          promptSeq,
          sessionId,
          blobs,
          signal,
        );
      }
    }
  }
  return null;
}
