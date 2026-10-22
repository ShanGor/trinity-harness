import type { AcpClient } from '@trinity-harness/client-acp';
import type { TimelinePage } from '@trinity-harness/shared';

/** A tool-heavy turn can occupy several pages; include its original prompt. */
export async function loadTimelineWithPrompt(
  client: Pick<AcpClient, 'getTimeline'>,
  sessionId: string,
  beforeSeq?: number,
  cancelled: () => boolean = () => false,
): Promise<TimelinePage> {
  const latest = await client.getTimeline(sessionId, beforeSeq);
  let events = latest.events;
  let before = latest.nextBefore;
  while (
    before !== null &&
    !cancelled() &&
    !events.some((event) => event.type === 'message/committed' && event.message.role === 'user')
  ) {
    const page = await client.getTimeline(sessionId, before);
    if (page.nextBefore !== null && page.nextBefore >= before)
      throw new Error('History cursor did not advance');
    events = [...page.events, ...events];
    before = page.nextBefore;
  }
  return { events, nextBefore: before, lastSeq: latest.lastSeq };
}
