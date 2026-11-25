import { memorySearchTerms, type TopicEpisode } from '@trinity-harness/contracts';

export const evaluationClock = new Date('2026-11-24T00:00:00.000Z');
export const evaluationEpisodes: TopicEpisode[] = [
  ['I work in Osaka.', '2026-09-01T00:00:00.000Z', 'profile'],
  ['I moved to Kyoto.', '2026-11-20T00:00:00.000Z', 'profile'],
  ['我喜欢清淡的食物。', '2026-11-21T00:00:00.000Z', 'food'],
  ['My dog is called Pepper.', '2026-11-22T00:00:00.000Z', 'pet'],
  ['The launch is on December 8.', '2026-11-23T00:00:00.000Z', 'project'],
].map(([request, at, topic], i) => ({
  episodeId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  promptId: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  sessionId: '00000000-0000-4000-8000-000000000099',
  fromSeq: i * 3 + 1,
  toSeq: i * 3 + 3,
  answerSeq: i * 3 + 2,
  request: request!,
  outcome: 'Acknowledged.',
  at: at!,
  topic: topic!,
  excluded: false,
  policyRevision: 0,
}));
export const evaluationQuestions = [
  { category: 'fact', query: 'Pepper', expected: 3 },
  { category: 'correction', query: 'Where do I live now?', expected: 1 },
  { category: 'time', query: 'launch', expected: 4 },
  { category: 'paraphrase', query: 'What is my canine companion named?', expected: 3 },
  { category: 'cross-language', query: 'What food do I prefer?', expected: 2 },
  { category: 'negative', query: 'mortgage', expected: null },
] as const;

// Additional phrasing is scored separately; keep the original 3/6 baseline stable.
export const evaluationHoldoutQuestions = [
  { category: 'fact', query: 'What is the name of my dog?', expected: 3 },
  { category: 'correction', query: 'Which city did I move to?', expected: 1 },
  { category: 'time', query: 'When is our launch?', expected: 4 },
  { category: 'cross-language', query: '我的狗叫什么名字？', expected: 3 },
  { category: 'cross-language', query: '我偏好什么口味？', expected: 2 },
  { category: 'cross-language', query: '发布定在哪天？', expected: 4 },
  { category: 'cross-language', query: '我现在搬到哪里了？', expected: 1 },
  { category: 'historical', query: 'What did I say about Osaka?', expected: 0 },
  { category: 'paraphrase', query: 'What meals do I enjoy?', expected: 2 },
  { category: 'negative', query: 'passport renewal', expected: null },
  { category: 'negative', query: '血型', expected: null },
] as const;

/** Mirrors PgConversationIndex's OR ILIKE and descending insertion order on literal fixtures. */
export function lexicalFixture(query: string): TopicEpisode[] {
  const terms = memorySearchTerms(query);
  return evaluationEpisodes
    .toReversed()
    .filter(
      (e) =>
        !terms.length ||
        terms.some((t) => `${e.request} ${e.outcome} ${e.topic}`.toLowerCase().includes(t)),
    )
    .slice(0, 10);
}
