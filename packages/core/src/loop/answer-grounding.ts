import {
  answerCitationListSchema,
  researchResultSchema,
  type AnswerCitation,
  type BlobStore,
  type SessionEvent,
} from '@trinity-harness/contracts';
import { browserDeliveries, resolveBrowserImage } from '../tools/browser-artifacts.js';
import { resolveBrowserSource } from '../tools/browser-evidence.js';
import { observedPages, resultValue } from '../tools/research.js';
import { z } from 'zod';

const fileObservationSchema = z.object({ path: z.string().min(1).max(2000), content: z.string() });

/** Build bounded evidence metadata from successful current-turn observations. */
export async function answerGrounding(
  events: readonly SessionEvent[],
  promptSeq: number,
  sessionId: string,
  blobs?: BlobStore,
  signal?: AbortSignal,
): Promise<AnswerCitation[]> {
  const pages = await observedPages(events, promptSeq, sessionId, blobs, signal);
  const calls = new Map<string, Extract<SessionEvent, { type: 'tool/call' }>>();
  const citations = new Map<string, AnswerCitation>();
  let claims: AnswerCitation[] = [];
  if (blobs)
    for (const delivery of browserDeliveries(events, sessionId, promptSeq)) {
      if (delivery.result.image) {
        try {
          await resolveBrowserImage(blobs, events, sessionId, delivery.result.image.uri);
          citations.set(`image:${delivery.result.observationId}`, {
            kind: 'web_source',
            label: `Visual observation: ${delivery.result.title || delivery.result.url}`.slice(
              0,
              1000,
            ),
            detail: `Viewport screenshot (${delivery.result.image.width} × ${delivery.result.image.height}); visual evidence only.`,
            url: delivery.result.url,
            callId: delivery.callId,
            evidenceSeq: delivery.seq,
            observationId: delivery.result.observationId,
            artifactUri: delivery.result.artifactUri,
            capturedAt: delivery.result.capturedAt,
            imageUri: delivery.result.image.uri,
          });
        } catch {
          signal?.throwIfAborted();
        }
      }
      for (const block of delivery.result.blocks.slice(0, 1)) {
        try {
          const source = await resolveBrowserSource(
            {
              observationId: delivery.result.observationId,
              blockId: block.id,
              start: block.start,
              end: Math.min(block.end, block.start + 250),
            },
            events.slice(0, delivery.seq),
            promptSeq,
            sessionId,
            blobs,
            signal,
          );
          citations.set(`web:${source.url}`, {
            kind: 'web_source',
            label: (delivery.result.title || source.url).slice(0, 1000),
            detail: source.quote,
            url: source.url,
            callId: source.callId,
            evidenceSeq: source.evidenceSeq,
            observationId: source.observationId,
            blockId: source.blockId,
            start: source.start,
            end: source.end,
            artifactUri: source.artifactUri,
            capturedAt: source.capturedAt,
          });
        } catch {
          signal?.throwIfAborted(); /* Missing/corrupt evidence cannot ground an answer. */
        }
      }
    }
  for (let i = promptSeq; i < events.length; i++) {
    signal?.throwIfAborted();
    const event = events[i]!;
    if (event.type === 'tool/call') calls.set(event.callId, event);
    if (event.type !== 'tool/result' || event.isError) continue;
    const call = calls.get(event.callId);
    const page = pages.get(event.callId);
    if (page)
      citations.set(`web:${page.url}`, {
        kind: 'web_source',
        label: (page.title || page.url).slice(0, 1000),
        url: page.url,
        detail: page.text.slice(0, 600),
        callId: event.callId,
        evidenceSeq: i + 1,
      });
    if (call?.name === 'read_file') {
      const parsedFile = fileObservationSchema.safeParse(
        await resultValue(event, sessionId, blobs, signal),
      );
      const value = parsedFile.success ? parsedFile.data : null;
      if (
        typeof value?.path === 'string' &&
        typeof value.content === 'string' &&
        value.path.length <= 2000 &&
        !/^(?:\/|[A-Za-z]:)|(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value.path)
      ) {
        citations.set(`file:${value.path}`, {
          kind: 'workspace_reference',
          label: value.path.slice(0, 1000),
          path: value.path,
          callId: event.callId,
          evidenceSeq: i + 1,
        });
      }
    }
    if (call?.name === 'research') {
      const parsed = researchResultSchema.safeParse(
        await resultValue(event, sessionId, blobs, signal),
      );
      if (parsed.success && parsed.data.promptSeq === promptSeq && parsed.data.notes) {
        const validated = await Promise.all(
          parsed.data.notes.findings.map(async (finding) => {
            const valid = await Promise.all(
              finding.sources.map(async (source) => {
                if (source.observationId && source.blockId) {
                  if (!blobs) return false;
                  try {
                    const resolved = await resolveBrowserSource(
                      {
                        observationId: source.observationId,
                        blockId: source.blockId,
                        start: source.start,
                        end: source.end,
                      },
                      events.slice(0, i),
                      promptSeq,
                      sessionId,
                      blobs,
                      signal,
                    );
                    return (
                      resolved.url === source.url &&
                      resolved.quote === source.quote &&
                      resolved.callId === source.callId
                    );
                  } catch {
                    signal?.throwIfAborted();
                    return false;
                  }
                }
                const observed = source.callId ? pages.get(source.callId) : undefined;
                return (
                  observed?.url === source.url &&
                  observed.text.replace(/\s+/g, ' ').includes(source.quote.replace(/\s+/g, ' '))
                );
              }),
            );
            return valid.every(Boolean) ? finding : null;
          }),
        );
        claims = validated
          .filter((finding) => finding !== null)
          .map((finding) => ({
            kind: 'research_claim',
            label: finding.claim,
            claimText: finding.claim,
            sourceUrls: [...new Set(finding.sources.map((source) => source.url))],
            detail: finding.sources
              .map((source) => source.quote)
              .join('\n')
              .slice(0, 1000),
            callId: event.callId,
            evidenceSeq: i + 1,
          }));
      }
    }
  }
  return answerCitationListSchema.parse([...citations.values(), ...claims].slice(0, 60));
}
