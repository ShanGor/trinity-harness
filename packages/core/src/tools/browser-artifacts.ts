import { createHash } from 'node:crypto';
import {
  BROWSER_LIMITS,
  browserObservationSchema,
  browserResultSchema,
  type BlobStore,
  type BrowserObservation,
  type BrowserRange,
  type BrowserResult,
  type SessionEvent,
} from '@trinity-harness/contracts';

/** Sorted object keys, array order preserved, JSON number/string encoding. */
export function canonicalBrowserJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalBrowserJson).join(',') + ']';
  if (value && typeof value === 'object')
    return (
      '{' +
      Object.entries(value)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, v]) => JSON.stringify(key) + ':' + canonicalBrowserJson(v))
        .join(',') +
      '}'
    );
  return JSON.stringify(value);
}
export function browserHash(
  observation: Omit<BrowserObservation, 'hash'> | BrowserObservation,
): string {
  const { hash: _hash, ...payload } = observation as BrowserObservation;
  void _hash;
  return createHash('sha256').update(canonicalBrowserJson(payload)).digest('hex');
}
export function browserArtifactUri(sessionId: string, observationId: string): string {
  return `blob://browser/${encodeURIComponent(sessionId)}/${observationId}.json`;
}
/** Source deletion/replacement fences apply to stored artifacts as well as current context. */
export function suppressedBrowserCalls(events: readonly SessionEvent[]): Set<string> {
  const prompts = new Set(
    events.flatMap((event) =>
      event.type === 'message/removed' || event.type === 'prompt/discarded'
        ? [event.promptId]
        : event.type === 'message/user' && event.revision
          ? [event.revision.promptId]
          : [],
    ),
  );
  const suppressed = new Set<string>();
  let promptId: string | undefined;
  for (const event of events) {
    if (event.type === 'message/user') promptId = event.eventId;
    if (event.type === 'tool/call' && event.name === 'browser' && promptId && prompts.has(promptId))
      suppressed.add(event.callId);
  }
  return suppressed;
}
export function browserDeliveries(
  events: readonly SessionEvent[],
  sessionId: string,
  from = 0,
): { result: BrowserResult; callId: string; seq: number }[] {
  const calls = new Set<string>();
  const suppressed = suppressedBrowserCalls(events);
  const deliveries: { result: BrowserResult; callId: string; seq: number }[] = [];
  for (let i = from; i < events.length; i++) {
    const event = events[i]!;
    if (event.type === 'tool/call' && event.name === 'browser' && !suppressed.has(event.callId))
      calls.add(event.callId);
    if (event.type !== 'tool/result' || event.isError || !calls.has(event.callId)) continue;
    const parsed = browserResultSchema.safeParse(event.value);
    if (
      !parsed.success ||
      parsed.data.sessionId !== sessionId ||
      parsed.data.callId !== event.callId ||
      parsed.data.artifactUri !== browserArtifactUri(sessionId, parsed.data.observationId)
    )
      continue;
    const result = parsed.data;
    if (
      ['capture_document', 'read_capture', 'search_capture', 'export_capture'].includes(
        result.operation,
      )
    )
      continue;
    if (result.snapshot && result.snapshot.snapshotId !== result.observationId) continue;
    if (
      result.image &&
      result.image.uri !==
        `blob://browser/${encodeURIComponent(sessionId)}/${result.observationId}.png`
    )
      continue;
    if (
      result.blocks.length !== result.receipt.length ||
      result.blocks.some((block, j) => {
        const range = result.receipt[j]!;
        return (
          range.blockId !== block.id ||
          range.start !== block.start ||
          range.end !== block.end ||
          Array.from(block.text).length !== range.end - range.start
        );
      })
    )
      continue;
    deliveries.push({ result, callId: event.callId, seq: i + 1 });
  }
  return deliveries;
}
export async function loadBrowserObservation(
  blobs: BlobStore,
  events: readonly SessionEvent[],
  sessionId: string,
  observationId: string,
  signal?: AbortSignal,
): Promise<BrowserObservation> {
  if (
    !browserDeliveries(events, sessionId).some(
      ({ result }) => result.observationId === observationId,
    )
  )
    throw new Error('Observation is not authorized by a successful session result');
  signal?.throwIfAborted();
  const uri = browserArtifactUri(sessionId, observationId);
  const metadata = await blobs.getMeta(uri);
  if (!metadata || metadata.size > BROWSER_LIMITS.artifact)
    throw new Error('Observation artifact unavailable');
  const bytes = await blobs.get(uri);
  signal?.throwIfAborted();
  if (!bytes || bytes.byteLength > BROWSER_LIMITS.artifact)
    throw new Error('Observation artifact unavailable');
  const parsed = browserObservationSchema.parse(
    JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
  );
  if (
    parsed.sessionId !== sessionId ||
    parsed.observationId !== observationId ||
    browserHash(parsed) !== parsed.hash ||
    parsed.blocks.some((b, i) => b.id !== `b${i}`)
  )
    throw new Error('Invalid observation integrity');
  if (parsed.derivation) {
    const { loadDocumentCapture, convertDocumentCapture } = await import('./browser-documents.js');
    const manifest = await loadDocumentCapture(
      blobs,
      events,
      sessionId,
      parsed.derivation.captureId,
      signal,
    );
    if (manifest.hash !== parsed.derivation.captureHash)
      throw new Error('Capture derivation integrity failure');
    const converted = convertDocumentCapture(
      manifest,
      parsed.derivation.rootDocumentId,
      parsed.derivation.offset,
    );
    if (
      canonicalBrowserJson(converted.blocks) !== canonicalBrowserJson(parsed.blocks) ||
      canonicalBrowserJson(converted.derivation) !== canonicalBrowserJson(parsed.derivation)
    )
      throw new Error('Capture source mapping mismatch');
  }
  return parsed;
}
export function browserPromptIndex(events: readonly SessionEvent[]): number {
  for (let i = events.length - 1; i >= 0; i--) if (events[i]!.type === 'message/user') return i + 1;
  return 0;
}
export function exposedBrowserRange(result: BrowserResult, range: BrowserRange): boolean {
  // Adjacent delivered slices may collectively authorize a longer source range.
  let cursor = range.start;
  for (const delivered of result.receipt
    .filter((r) => r.blockId === range.blockId)
    .sort((a, b) => a.start - b.start)) {
    if (delivered.start > cursor) break;
    if (delivered.end > cursor) cursor = delivered.end;
  }
  return cursor >= range.end;
}

/** Resolve only a committed, current-turn image receipt, with byte/hash verification. */
export async function resolveBrowserImage(
  blobs: BlobStore,
  events: readonly SessionEvent[],
  sessionId: string,
  uri: string,
  currentTurnOnly = true,
): Promise<Uint8Array> {
  const delivery = browserDeliveries(
    events,
    sessionId,
    currentTurnOnly ? browserPromptIndex(events) : 0,
  ).find((d) => d.result.image?.uri === uri);
  if (!delivery?.result.image) throw new Error('Browser image is not authorized');
  const observation = await loadBrowserObservation(
    blobs,
    events,
    sessionId,
    delivery.result.observationId,
  );
  const image = observation.image;
  if (!image || canonicalBrowserJson(image) !== canonicalBrowserJson(delivery.result.image))
    throw new Error('Browser image receipt mismatch');
  const metadata = await blobs.getMeta(uri);
  if (!metadata || metadata.size !== image.bytes || metadata.size > BROWSER_LIMITS.image)
    throw new Error('Browser image unavailable');
  const bytes = await blobs.get(uri);
  if (
    !bytes ||
    bytes.length !== image.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== image.hash
  )
    throw new Error('Browser image integrity failure');
  return bytes;
}
