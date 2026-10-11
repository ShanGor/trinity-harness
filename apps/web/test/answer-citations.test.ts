// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { AnswerCitationList } from '../src/answer-citations';
it('renders persisted visual evidence in the existing evidence drawer', async () => {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  const renderImage = vi.fn((uri: string) =>
    createElement('img', { alt: 'Visual evidence', src: uri }),
  );
  try {
    await act(async () =>
      root.render(
        createElement(AnswerCitationList, {
          renderImage,
          citations: [
            {
              kind: 'web_source',
              label: 'Visual observation',
              url: 'https://example.com',
              callId: 'shot',
              evidenceSeq: 3,
              imageUri: 'blob://browser/session/shot.png',
              detail: 'Visual evidence only.',
            },
          ],
        }),
      ),
    );
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.textContent === 'View evidence',
    )!;
    await act(async () => button.click());
    expect(document.body.querySelector('img[alt="Visual evidence"]')?.getAttribute('src')).toBe(
      'blob://browser/session/shot.png',
    );
    expect(document.body.textContent).toContain('Visual evidence only.');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
