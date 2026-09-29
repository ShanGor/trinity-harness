import { describe, expect, it } from 'vitest';

import type { SessionEvent } from '../src/index.js';
import { compactionRanges, foldSurface, isCompacted, projectMessages } from '../src/index.js';

const now = new Date().toISOString();
const id = () => crypto.randomUUID();
const text = (t: string) => ({ kind: 'text' as const, text: t });

function user(t: string): SessionEvent {
  return { type: 'message/user', eventId: id(), at: now, surfaceOp: 'append', content: [text(t)] };
}
function assistant(t: string): SessionEvent {
  return {
    type: 'message/assistant',
    eventId: id(),
    at: now,
    surfaceOp: 'append',
    content: [text(t)],
  };
}
function compaction(fromSeq: number, toSeq: number, summary = 'summary'): SessionEvent {
  return { type: 'compaction/summary', eventId: id(), at: now, fromSeq, toSeq, summary };
}

describe('compaction-aware projection (M4, docs/design.md §7)', () => {
  it('replaces the covered surface range IN PLACE with a synthetic summary message', () => {
    // seq: 1=user(a) 2=assistant(x) 3=user(b) 4=assistant(y) 5=compaction[1,2]
    const events = [user('a'), assistant('x'), user('b'), assistant('y'), compaction(1, 2, ' AX')];
    const surface = projectMessages(events);
    // In-place: the summary takes the position of the first covered event.
    expect(surface.map((m) => m.role)).toEqual(['user', 'user', 'assistant']);
    expect(surface[0]!.content[0]).toEqual(
      expect.objectContaining({ kind: 'text', text: expect.stringContaining('AX') }),
    );
    expect(surface[1]!.content).toEqual([text('b')]);
    expect(surface[2]!.content).toEqual([text('y')]);
  });

  it('keeps history intact — the log still holds the original events', () => {
    const events = [user('a'), assistant('x'), compaction(1, 2, 's')];
    expect(events).toHaveLength(3); // append-only: nothing is deleted
    expect(compactionRanges(events)).toEqual([{ fromSeq: 1, toSeq: 2, summary: 's', seq: 3 }]);
    expect(isCompacted(1, compactionRanges(events))).toBe(true);
    expect(isCompacted(2, compactionRanges(events))).toBe(true);
    expect(isCompacted(3, compactionRanges(events))).toBe(false);
  });

  it('supports sequential compactions (second range after the first summary event)', () => {
    // 1=user(a) 2=assistant(x) 3=compaction[1,2] 4=user(b) 5=assistant(y) 6=compaction[4,5]
    const events = [
      user('a'),
      assistant('x'),
      compaction(1, 2, 'first'),
      user('b'),
      assistant('y'),
      compaction(4, 5, 'second'),
    ];
    const surface = projectMessages(events);
    expect(surface).toHaveLength(2);
    expect(surface[0]!.content[0]).toEqual(
      expect.objectContaining({ kind: 'text', text: expect.stringContaining('first') }),
    );
    expect(surface[1]!.content[0]).toEqual(
      expect.objectContaining({ kind: 'text', text: expect.stringContaining('second') }),
    );
  });

  it('assistant replace settle keeps the entry span across its events', () => {
    const events: SessionEvent[] = [
      user('a'),
      {
        type: 'message/assistant',
        eventId: id(),
        at: now,
        surfaceOp: 'append',
        content: [text('partial')],
      },
      {
        type: 'message/assistant',
        eventId: id(),
        at: now,
        surfaceOp: 'replace',
        content: [text('settled')],
      },
    ];
    const surface = foldSurface(events);
    expect(surface).toHaveLength(2);
    expect(surface[1]).toMatchObject({ role: 'assistant', fromSeq: 2, toSeq: 3 });
  });

  it('keeps partially-covered entries (boundary selection prevents this in practice)', () => {
    const events = [user('a'), assistant('x'), compaction(2, 2, 'only-assistant')];
    const surface = projectMessages(events);
    // user entry [1,1] not covered ⇒ kept; summary replaces assistant.
    expect(surface.map((m) => m.role)).toEqual(['user', 'user']);
    expect(surface[0]!.content).toEqual([text('a')]);
  });
});
