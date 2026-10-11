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
  if (!block) throw new Error('Unknown evidence block');
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
    throw new Error('Invalid evidence range');
  const quote = points.slice(range.start, range.end).join('');
  if (quote.length > 600) throw new Error('Select a source range of at most 600 characters');
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
    throw new Error('Cited range was not exposed in a successful current-turn browser result');
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
