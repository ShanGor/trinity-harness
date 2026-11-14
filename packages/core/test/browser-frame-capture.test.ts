import { expect, it } from 'vitest';
import { browserCaptureSchema } from '@trinity-harness/contracts';
import { captureEmbeddedFrames } from '../src/tools/browser-frame-capture.js';
import type { ZendriverClient } from '../src/tools/zendriver-mcp.js';
const capture = () =>
  browserCaptureSchema.parse({
    schemaVersion: 1,
    extractorVersion: 'semantic-v2',
    url: 'https://parent.example/',
    title: 'Shell',
    publishedAt: null,
    readiness: 'partial',
    representation: 'article',
    scope: 'body',
    exclusions: [],
    blocks: [],
    captureTruncated: false,
  });
function client(privateFrame = false, visible = true, changed = false): ZendriverClient {
  let lists = 0;
  return {
    async call(name, args) {
      if (name === 'browser_frame_list')
        return {
          content: [],
          structuredContent: {
            frames: [
              { id: 'main', url: 'https://parent.example/', parent_id: null, is_main: true },
              {
                id: 'child',
                url:
                  changed && lists++ > 0
                    ? 'https://child.example/changed'
                    : 'https://child.example/',
                parent_id: 'main',
                is_main: false,
              },
            ],
          },
        };
      if (name !== 'browser_evaluate') throw new Error('Unexpected effect');
      const expression = String(args.expression);
      const value = expression.includes('semantic-v2')
        ? {
            ...capture(),
            url: 'https://child.example/',
            blocks: [
              { id: 'b0', kind: 'paragraph', text: 'Embedded content', sectionId: null, links: [] },
            ],
          }
        : expression.includes('privacyDenied')
          ? { privacyDenied: privateFrame }
          : visible
            ? ['https://child.example/']
            : [];
      return { content: [], structuredContent: { value } };
    },
  };
}
it('reads a visible child and retains its text without navigation', async () => {
  expect((await captureEmbeddedFrames(client(), capture(), 'article')).blocks[0]?.text).toBe(
    'Embedded content',
  );
});
it('does not read an unobserved hidden child', async () => {
  expect((await captureEmbeddedFrames(client(false, false), capture(), 'article')).blocks).toEqual(
    [],
  );
});
it('rejects protected child content and changed frame identities', async () => {
  await expect(captureEmbeddedFrames(client(true), capture(), 'article')).rejects.toMatchObject({
    code: 'PRIVACY_DENIED',
  });
  await expect(
    captureEmbeddedFrames(client(false, true, true), capture(), 'article'),
  ).rejects.toMatchObject({ code: 'STALE_TARGET' });
});

it('checks scoped-read frame privacy without delivering content outside the scope', async () => {
  expect(
    (await captureEmbeddedFrames(client(), capture(), 'article', undefined, true)).blocks,
  ).toEqual([]);
  await expect(
    captureEmbeddedFrames(client(true), capture(), 'article', undefined, true),
  ).rejects.toMatchObject({ code: 'PRIVACY_DENIED' });
});
