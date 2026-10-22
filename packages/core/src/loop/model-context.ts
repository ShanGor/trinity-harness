import { createHash } from 'node:crypto';
import type { BlobStore, LLMRequest, SessionEvent } from '@trinity-harness/contracts';

/** Private request artifacts preserve inputs without duplicating file contents in the log. */
export async function modelContextRecord(
  request: LLMRequest,
  events: readonly SessionEvent[],
  sessionId: string,
  promptId: string,
  requestId: string,
  purpose: 'assistant' | 'compaction',
  blobs?: BlobStore,
): Promise<Omit<Extract<SessionEvent, { type: 'model/context' }>, 'eventId' | 'at'>> {
  const data = new TextEncoder().encode(
    JSON.stringify({
      model: request.model,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
      maxOutputTokens: request.maxOutputTokens,
    }),
  );
  let snapshotUri: string | undefined;
  if (blobs) {
    try {
      snapshotUri = (
        await blobs.put(`model-context/${sessionId}/${requestId}.json`, data, {
          mimeType: 'application/json',
        })
      ).uri;
    } catch {
      throw Object.assign(new Error('Model input snapshot could not be persisted.'), {
        code: 'MODEL_CONTEXT_PERSISTENCE_FAILED',
      });
    }
  }
  const selection = events.findLast(
    (event) => event.type === 'memory/selection' && event.receipt.promptId === promptId,
  );
  return {
    type: 'model/context',
    version: 2,
    promptId,
    requestId,
    purpose,
    sourceToSeq: events.length,
    digest: createHash('sha256').update(data).digest('hex'),
    bytes: data.byteLength,
    ...(purpose === 'assistant' && selection ? { selectionEventId: selection.eventId } : {}),
    ...(snapshotUri ? { snapshotUri } : {}),
  };
}
