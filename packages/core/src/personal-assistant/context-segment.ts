import type { RecallReceipt } from '@trinity-harness/contracts';

type Dialogue = NonNullable<RecallReceipt['dialogue']>;
type Segment = NonNullable<RecallReceipt['segment']>;

function size(dialogue: Dialogue): number {
  return dialogue.reduce(
    (sum, turn) => sum + turn.request.text.length + turn.answer.text.length,
    0,
  );
}

/** Select a recent seed once, leaving capacity for append-only admission. */
function seed(candidates: Dialogue, capacity: number): Dialogue {
  const selected: Dialogue = [];
  let remaining = Math.floor(capacity / 2);
  for (const turn of candidates.toReversed()) {
    const length = size([turn]);
    if (length <= remaining) {
      selected.unshift(turn);
      remaining -= length;
    } else {
      // The most recent oversized answer still needs an exact expansion anchor.
      if (!selected.length && capacity > 0) {
        const request = { ...turn.request };
        const answer = { ...turn.answer };
        request.text = request.text.slice(0, Math.floor(capacity / 4));
        request.to = request.from + request.text.length;
        answer.text = answer.text.slice(0, capacity - request.text.length);
        answer.to = answer.from + answer.text.length;
        selected.push({ ...turn, request, answer });
      }
      break;
    }
  }
  return selected;
}

/** Pure admission over authorized immutable source snapshots; the caller commits the receipt. */
export function selectContextSegment(
  candidates: Dialogue,
  previous: RecallReceipt | undefined,
  options: { id: string; configuration: string; policyRevision: number; capacity: number },
): { dialogue: Dialogue; segment: Segment } {
  const prior = previous?.segment;
  let reason: Segment['reason'] = 'initial';
  const available = new Map(candidates.map((turn) => [turn.promptId, turn]));
  if (prior && previous) {
    reason =
      previous.policyRevision !== options.policyRevision
        ? 'policy'
        : prior.configuration !== options.configuration
          ? 'configuration'
          : (previous.dialogue ?? []).some((turn) => {
                const source = available.get(turn.promptId);
                return (
                  !source ||
                  source.request.eventId !== turn.request.eventId ||
                  source.answer.eventId !== turn.answer.eventId
                );
              })
            ? 'source'
            : 'capacity';
    if (reason === 'capacity') {
      const retained = previous.dialogue ?? [];
      const watermark = retained.at(-1)?.answer.seq ?? 0;
      const additions = candidates.filter((turn) => turn.request.seq > watermark);
      const dialogue = [...retained, ...additions];
      if (dialogue.length <= 64 && size(dialogue) <= options.capacity)
        return { dialogue, segment: prior };
    }
  }
  return {
    dialogue: seed(candidates, options.capacity),
    segment: {
      id: options.id,
      revision: (prior?.revision ?? 0) + 1,
      configuration: options.configuration,
      reason,
      capacity: options.capacity,
    },
  };
}
