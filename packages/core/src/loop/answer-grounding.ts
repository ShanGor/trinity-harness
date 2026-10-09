import {
  answerCitationListSchema,
  researchResultSchema,
  type AnswerCitation,
  type BlobStore,
  type SessionEvent,
} from '@trinity-harness/contracts';
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
        claims = parsed.data.notes.findings
          .filter((finding) =>
            finding.sources.every((source) => {
              const observed = source.callId ? pages.get(source.callId) : undefined;
              return (
                observed?.url === source.url &&
                observed.text.replace(/\s+/g, ' ').includes(source.quote.replace(/\s+/g, ' '))
              );
            }),
          )
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
