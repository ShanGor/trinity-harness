import { expect, it } from 'vitest';
import { browserObservationSchema } from '@trinity-harness/contracts';
import { browserMarkdown } from '../src/tools/browser-markdown.js';

it('exports captured headings, code fences and observed images with honest coverage', () => {
  const observation = browserObservationSchema.parse({
    schemaVersion: 1,
    extractorVersion: 'semantic-v2',
    url: 'https://example.com/',
    title: 'Article',
    publishedAt: null,
    readiness: 'partial',
    representation: 'article',
    scope: 'body',
    exclusions: [],
    captureTruncated: false,
    observationId: 'obs',
    sessionId: 's',
    bindingId: 'binding',
    tabId: 'tab',
    documentRevision: 'rev',
    cliVersion: '1',
    browserVersion: '1',
    capturedAt: '2026-01-01T00:00:00.000Z',
    hash: '0'.repeat(64),
    blocks: [
      { id: 'b0', kind: 'heading', text: 'Section', level: 3, sectionId: 'b0', links: [] },
      { id: 'b1', kind: 'code', text: '```\ncode', sectionId: 'b0', links: [] },
      {
        id: 'b2',
        kind: 'paragraph',
        text: 'Diagram',
        sectionId: 'b0',
        links: [],
        image: { url: 'https://example.com/image.png', alt: 'Diagram' },
      },
    ],
  });
  const result = browserMarkdown(observation);
  expect(result.markdown).toContain('### Section');
  expect(result.markdown).toContain('````\n```\ncode\n````');
  expect(result.markdown).toContain('![Diagram](<https://example.com/image.png>)');
  expect(result.markdown).toContain('Partial capture');
  expect(result.summary.imageDelivery).toBe('remote-references');
  observation.blocks[2]!.image!.data = 'data:image/png;base64,aGVsbG8=';
  const embedded = browserMarkdown(observation);
  expect(embedded.markdown).toContain('data:image/png;base64,aGVsbG8=');
  expect(embedded.summary.imageDelivery).toBe('embedded');
});
