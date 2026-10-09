// @vitest-environment jsdom
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { researchPageSchema } from '@trinity-harness/contracts';

const { document, window } = globalThis as unknown as {
  document: { documentElement: { innerHTML: string; outerHTML: string } };
  window: { eval: (script: string) => unknown };
};

const script = readFileSync(path.resolve('skills/agent-browser/scripts/extract-page.js'), 'utf8');
function extract(html: string): ReturnType<typeof researchPageSchema.parse> {
  document.documentElement.innerHTML = html;
  // The installed CLI evaluates the same browser-side expression.
  const result: unknown = window.eval(script);
  return researchPageSchema.parse(result);
}
describe('browser evidence extractor', () => {
  it('extracts article text, publication metadata, and real links in one observation', () => {
    const page = extract(
      '<head><title>Feature announcement</title><meta property="article:published_time" content="2026-01-02"></head><body><nav>Unrelated navigation</nav><main><article><h1>Feature announcement</h1><p>Product A renders interactive apps.</p><p>Distribution through Product B is available.</p><a href="https://example.com/docs">Product documentation</a><aside>Other article June 2099</aside><script>doNotExecute()</script></article></main></body>',
    );
    expect(page.title).toBe('Feature announcement');
    expect(page.publishedAt).toBe('2026-01-02');
    expect(page.text).toContain('Product A renders interactive apps.');
    expect(page.text).not.toContain('Unrelated navigation');
    expect(page.text).not.toContain('June 2099');
    expect(page.text).not.toContain('doNotExecute');
    expect(page.links).toEqual([
      { title: 'Product documentation', url: 'https://example.com/docs' },
    ]);
    expect(page.truncated).toBe(false);
  });
  it('leaves unknown publication dates null instead of reading sidebar dates', () => {
    const page = extract(
      '<head><title>Guide</title></head><body><aside><time datetime="2099-01-01">Jan 2099</time></aside><main><h1>Guide</h1><p>Read the actual guide.</p></main></body>',
    );
    expect(page.publishedAt).toBeNull();
    expect(page.text).toContain('Read the actual guide.');
  });
  it('bounds output and omits unsafe or duplicate links', () => {
    const links = Array.from(
      { length: 60 },
      (_, i) => `<a href="https://example.com/${i}">Link ${i}</a>`,
    ).join('');
    const page = extract(
      `<head><title>Long page</title></head><body><main><p>${'x'.repeat(30000)}</p><a href="javascript:evil()">unsafe</a><a href="https://user:secret@example.com">credentials</a>${links}<a href="https://example.com/0#section">duplicate</a></main></body>`,
    );
    expect(page.text.length).toBe(24000);
    expect(page.truncated).toBe(true);
    expect(page.links).toHaveLength(40);
    expect(page.links.some((link) => link.title === 'unsafe' || link.title === 'credentials')).toBe(
      false,
    );
  });
  it('is read-only and remains usable as a single quoted shell argument', () => {
    document.documentElement.innerHTML =
      '<head><title>Safe</title></head><body><main>Text</main></body>';
    const before = document.documentElement.outerHTML;
    window.eval(script);
    expect(document.documentElement.outerHTML).toBe(before);
    expect(script.includes("'")).toBe(false);
  });
});

it('selects the main article body rather than an earlier recommendation or longer comments', () => {
  const page = extract(
    `<head><title>Actual announcement</title></head><body><main><article><p>Related article: Teams setup</p></article><article><div class="entry-content"><h2>Actual announcement body</h2><p>Product A supports the interactive UI. Product B distribution is a separate claim.</p><a href="https://example.com/primary">Primary announcement</a></div></article><article class="comment"><p>${'irrelevant opinion '.repeat(100)}</p></article></main></body>`,
  );
  expect(page.text).toContain('Product B distribution is a separate claim.');
  expect(page.text).not.toContain('Related article');
  expect(page.text).not.toContain('irrelevant opinion');
  expect(page.links[0]?.url).toBe('https://example.com/primary');
});

it('prefers the main guide over a recommendation article without the page heading', () => {
  const page = extract(
    `<head><title>Product documentation</title></head><body><main><div><h1>Actual product guide</h1><p>The product supports protocol tools. Interactive UI support is not stated here.</p></div><article><p>${'Related articles and recommendations. '.repeat(20)}</p></article></main></body>`,
  );
  expect(page.text).toContain('Interactive UI support is not stated here.');
});
