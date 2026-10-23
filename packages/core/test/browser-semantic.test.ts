// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { browserCaptureSchema } from '@trinity-harness/contracts';
import { browserExtractor } from '../src/tools/browser-extractor.js';
const browser = globalThis as unknown as {
  document: { documentElement: { innerHTML: string; outerHTML: string } };
  window: {
    eval: (script: string) => unknown;
    Element: { prototype: { getClientRects: () => unknown } };
  };
};
function extract(html: string, mode: 'article' | 'documentation' = 'article') {
  browser.document.documentElement.innerHTML = html;
  vi.spyOn(browser.window.Element.prototype, 'getClientRects').mockReturnValue([{}]);
  const before = browser.document.documentElement.outerHTML;
  const result = browserCaptureSchema.parse(browser.window.eval(browserExtractor(mode)));
  expect(browser.document.documentElement.outerHTML).toBe(before);
  return result;
}
afterEach(() => vi.restoreAllMocks());
describe('visible semantic capture', () => {
  it('omits oversized link URLs while preserving their visible text and valid links', () => {
    const result = extract(
      `<body><main><p><a href="https://example.com/?q=${'x'.repeat(2000)}">Long redirect</a> and <a href="https://example.com/source">Source</a></p></main></body>`,
    );
    expect(result.blocks[0]!.text).toBe('Long redirect and Source');
    expect(result.blocks[0]!.links).toEqual([
      { title: 'Source', url: 'https://example.com/source' },
    ]);
  });
  it('reports an empty app shell as partial rather than ready', () => {
    const result = extract('<body><div id="app"></div></body>');
    expect(result.blocks).toEqual([]);
    expect(result.readiness).toBe('partial');
  });
  it('captures rendered SPA containers and inline links without semantic paragraph tags', () => {
    const result = extract(
      '<body><div id="app"><main><div><span>Model </span><a href="https://example.com/model"><span>details</span></a></div><div>Downloads: <span>42</span></div></main></div></body>',
    );
    expect(result.blocks.map((block) => block.text)).toEqual(['Model details', 'Downloads: 42']);
    expect(result.blocks[0]!.links).toEqual([
      { title: 'details', url: 'https://example.com/model' },
    ]);
  });
  it('keeps generic text in DOM order around semantic blocks without duplicating descendants', () => {
    const result = extract(
      '<body><main>Before <span>heading</span><h1>Title</h1><div>Intro <p>Paragraph</p>After <span>paragraph</span></div><div><div>Nested</div></div></main></body>',
    );
    expect(result.blocks.map((block) => block.text)).toEqual([
      'Before heading',
      'Title',
      'Intro',
      'Paragraph',
      'After paragraph',
      'Nested',
    ]);
  });
  it('applies privacy and visibility exclusions to generic SPA text', () => {
    const result = extract(
      '<body><main><div>Public <span hidden>HIDDEN</span><span style="display:none">SECRET</span><span contenteditable="true">DRAFT</span><span role="textbox">PRIVATE</span><input value="PASSWORD"><textarea>FORM</textarea><nav>NAV</nav><span>text</span></div></main></body>',
    );
    expect(result.blocks.map((block) => block.text)).toEqual(['Public text']);
  });
  it('keeps original Chinese punctuation, intervening UI text, duplicate block positions and null dates', () => {
    const result = extract(
      '<head><title>Nature</title></head><body><main><h1>论文</h1><p>论文标题：Late-life treatment <span>查看更多</span> 期刊：Nature “原文” 😀</p><p>Duplicate.</p><p>Duplicate.</p></main></body>',
    );
    expect(result.blocks[1]!.text).toBe(
      '论文标题：Late-life treatment 查看更多 期刊：Nature “原文” 😀',
    );
    expect(result.blocks.slice(2).map((b) => b.id)).toEqual(['b2', 'b3']);
    expect(result.publishedAt).toBeNull();
  });
  it('evaluates live visibility before cloning and excludes private inputs and collapsed/hidden content', () => {
    const result = extract(
      '<head><style>.private {display:none}</style></head><body><nav>Navigation</nav><main><p>Visible <span class="private">SECRET</span><input value="PASSWORD"><textarea>FORMVALUE</textarea><span hidden>HIDDEN</span></p><details><summary>Summary</summary><p>COLLAPSED</p></details><div aria-hidden="true"><p>ARIAHIDDEN</p></div><p style="visibility:hidden">CSSHIDDEN</p><script> SCRIPTSECRET </script></main></body>',
    );
    const text = result.blocks.map((b) => b.text).join('\n');
    expect(text).toContain('Visible');
    for (const omitted of [
      'SECRET',
      'PASSWORD',
      'FORMVALUE',
      'HIDDEN',
      'COLLAPSED',
      'ARIAHIDDEN',
      'CSSHIDDEN',
      'SCRIPTSECRET',
      'Navigation',
    ])
      expect(text).not.toContain(omitted);
  });
  it('retains documentation code whitespace, table headers/rows, lists and link URLs', () => {
    const result = extract(
      '<head><title>Docs</title><meta property="article:published_time" content="2026-01-01"></head><body><main><h1>Guide</h1><pre>function f() {\n  return "😀";\n}</pre><ul><li>First <a href="https://example.com/api">API</a></li><li>Second</li></ul><table><tr><th>Product</th><th>UI</th></tr><tr><td>Teams</td><td>Unconfirmed</td></tr></table></main></body>',
      'documentation',
    );
    expect(result.blocks[1]!.text).toBe('function f() {\n  return "😀";\n}');
    expect(result.blocks[2]!.links).toEqual([{ title: 'API', url: 'https://example.com/api' }]);
    expect(result.blocks.at(-1)).toMatchObject({
      kind: 'table',
      text: 'Product | UI\nTeams | Unconfirmed',
      rows: [
        [
          { text: 'Product', header: true },
          { text: 'UI', header: true },
        ],
        [
          { text: 'Teams', header: false },
          { text: 'Unconfirmed', header: false },
        ],
      ],
    });
    expect(result.publishedAt).toEqual({ value: '2026-01-01', origin: 'article:published_time' });
  });
  it('bounds capture within valid structured JSON and marks large blocks truncated', () => {
    const result = extract(`<body><main><p>${'😀'.repeat(40000)}</p></main></body>`);
    expect(Array.from(result.blocks[0]!.text)).toHaveLength(16000);
    expect(result.captureTruncated).toBe(true);
  });
});

it('selects an explicit article body over recommendations and longer comments', () => {
  const result = extract(
    `<body><main><article><p>Related recommendation</p></article><article><div class="entry-content"><h1>Primary article</h1><p>Product A supports interactive UI. Teams distribution is a separate claim.</p></div></article><article class="comment"><p>${'Comment noise '.repeat(1000)}</p></article></main></body>`,
  );
  const text = result.blocks.map((b) => b.text).join('\n');
  expect(text).toContain('Teams distribution is a separate claim.');
  expect(text).not.toContain('Related recommendation');
  expect(text).not.toContain('Comment noise');
});

it('preserves visible button labels, line breaks and nested list order while excluding editable drafts', () => {
  const result = extract(
    '<body><main><p>A<br>B<button>查看更多</button><span contenteditable="true">PRIVATE_DRAFT</span></p><ul><li>Parent<ul><li>Child</li></ul></li><li>Next</li></ul></main></body>',
  );
  expect(result.blocks.map((b) => b.text)).toEqual(['A B查看更多', 'Parent', 'Child', 'Next']);
});
