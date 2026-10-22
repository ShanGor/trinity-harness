import { describe, expect, it } from 'vitest';
import { browserUrlSchema } from '../src/browser.js';
import { answerCitationSchema } from '../src/citations.js';
import { researchNotesSchema, researchPageSchema } from '../src/research.js';

describe('source URL validation', () => {
  it.each(['', 'not a URL', 'https://', 'file:///tmp/source', 'https://user:password@example.com'])(
    'rejects %j as validation data rather than throwing',
    (url) => {
      expect(browserUrlSchema.safeParse(url).success).toBe(false);
      expect(
        researchPageSchema.safeParse({
          kind: 'trinity-research-page-v1',
          url,
          title: '',
          publishedAt: null,
          text: '',
          truncated: false,
          links: [],
        }).success,
      ).toBe(false);
      expect(
        answerCitationSchema.safeParse({
          kind: 'web_source',
          label: 'Source',
          callId: 'call',
          evidenceSeq: 1,
          url,
        }).success,
      ).toBe(false);
    },
  );

  it('preserves HTTP sources and block references without legacy URLs', () => {
    expect(browserUrlSchema.safeParse('https://example.com/source').success).toBe(true);
    expect(
      researchNotesSchema.safeParse({
        question: 'Question',
        findings: [
          {
            claim: 'Claim',
            relation: 'supports',
            sources: [{ observationId: 'observation', blockId: 'block', url: '', quote: '' }],
          },
        ],
        openQuestions: [],
        readyToAnswer: true,
      }).success,
    ).toBe(true);
  });
});
