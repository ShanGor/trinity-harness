/// <reference lib="dom" />
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { Readability } from '@mozilla/readability';
import {
  browserSurfaceSchema,
  browserSurfaceScript,
  browserReadinessScript,
  interactionFromSurface,
} from '../src/tools/browser-interactions.js';
import { browserExtractor } from '../src/tools/browser-extractor.js';
import { browserCaptureSchema } from '@trinity-harness/contracts';
const browser = globalThis as unknown as {
  window: Window & { eval: (script: string) => unknown; Element: { prototype: Element } };
  document: Document;
};
function setup(html: string): void {
  browser.document.documentElement.innerHTML = html;
  vi.spyOn(browser.window.Element.prototype, 'getClientRects').mockReturnValue([
    {},
  ] as unknown as DOMRectList);
  vi.spyOn(browser.window.Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    width: 100,
    height: 30,
    top: 0,
    left: 0,
    bottom: 30,
    right: 100,
    toJSON: () => ({}),
  });
  Object.defineProperty(browser.window.Element.prototype, 'innerText', {
    configurable: true,
    get(this: Element) {
      return this.textContent ?? '';
    },
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  Reflect.deleteProperty(browser.window.Element.prototype, 'innerText');
});
it('projects roles and accessible names without form values or hidden targets', () => {
  setup(
    '<body><main><h1>Controls</h1><label for="q">Search</label><input id="q" value="PRIVATE QUERY"><button aria-label="Expand details">+</button><button hidden>Hidden</button><div role="button" aria-labelledby="title"><span id="title">More</span></div></main></body>',
  );
  const result = browserSurfaceSchema.parse(
    browser.window.eval(browserSurfaceScript('interactive')),
  );
  expect(result.targets.map((t) => [t.role, t.name])).toEqual([
    ['textbox', 'Search'],
    ['button', 'Expand details'],
    ['button', 'More'],
  ]);
  expect(JSON.stringify(result)).not.toContain('PRIVATE QUERY');
  expect(result.targets[0]?.path).toEqual([1, 0, 2]);
});
it('scopes traversal using an observed DOM path and refuses missing scopes', () => {
  setup('<body><main><button>A</button><section><button>B</button></section></main></body>');
  const result = browserSurfaceSchema.parse(
    browser.window.eval(browserSurfaceScript('all', [1, 0, 1])),
  );
  expect(result.targets.map((t) => t.name)).toEqual(['B', 'B']);
  expect(() => browser.window.eval(browserSurfaceScript('all', [99]))).toThrow('scope unavailable');
});
it('refuses private forms and fingerprints geometry/role/name changes', () => {
  setup(
    '<body><main><input type="password" value="DO NOT RETURN"><button>A</button></main></body>',
  );
  const first = browserSurfaceSchema.parse(browser.window.eval(browserSurfaceScript()));
  expect(first.privacyDenied).toBe(true);
  expect(JSON.stringify(first)).not.toContain('DO NOT RETURN');
  const changed = { ...first, context: { ...first.context, scrollY: 50 } };
  expect(interactionFromSurface(first).fingerprint).not.toBe(
    interactionFromSurface(changed).fingerprint,
  );
});
it('bounds targets and marks truncated projections', () => {
  setup(`<body>${'<button>More</button>'.repeat(200)}</body>`);
  const result = browserSurfaceSchema.parse(browser.window.eval(browserSurfaceScript()));
  expect(result.targets).toHaveLength(100);
  expect(result.truncated).toBe(true);
});
it('uses mutation events and an injected fake clock for readiness and timeout', async () => {
  setup('<body><p>Loading</p></body>');
  vi.useFakeTimers();
  const ready = browser.window.eval(browserReadinessScript('Complete', 1000)) as Promise<string>;
  browser.document.querySelector('p')!.textContent = 'Complete';
  expect(await ready).toBe('ready');
  const timeout = browser.window.eval(browserReadinessScript('Absent', 100)) as Promise<string>;
  await vi.advanceTimersByTimeAsync(100);
  expect(await timeout).toBe('timed_out');
});
it('captures SPA content mounted after the initial empty shell', async () => {
  setup('<body><main id="app"></main></body>');
  vi.useFakeTimers();
  expect(
    browserCaptureSchema.parse(browser.window.eval(browserExtractor('article'))),
  ).toMatchObject({
    blocks: [],
    readiness: 'partial',
  });
  const ready = browser.window.eval(
    browserReadinessScript('Model details', 1000),
  ) as Promise<string>;
  browser.document.getElementById('app')!.innerHTML = '<div><span>Model details</span></div>';
  expect(await ready).toBe('ready');
  const capture = browserCaptureSchema.parse(browser.window.eval(browserExtractor('article')));
  expect(capture.blocks.map((block) => block.text)).toEqual(['Model details']);
  expect(capture.extractorVersion).toBe('semantic-v2');
});
it('compares article selection with Readability while retaining canonical punctuation, table cells and code', () => {
  setup(
    `<body><nav>${'Navigation '.repeat(50)}</nav><main><article><h1>Evidence</h1><p>论文标题：Late-life treatment 查看更多 期刊：Nature “原文” 😀</p><p>${'The study investigated a treatment in aged mice and does not establish human benefit. '.repeat(20)}</p><pre>const policy = {\n  egress: false\n};</pre><table><tr><th>Product</th><th>UI</th></tr><tr><td>Teams</td><td>Unconfirmed</td></tr></table></article></main></body>`,
  );
  const semantic = browserCaptureSchema.parse(browser.window.eval(browserExtractor('article')));
  const readability = new Readability(browser.document.cloneNode(true) as Document).parse();
  expect(readability?.textContent).toContain('does not establish human benefit');
  expect(
    semantic.blocks.some(
      (b) => b.kind === 'code' && b.text === 'const policy = {\n  egress: false\n};',
    ),
  ).toBe(true);
  expect(semantic.blocks.find((b) => b.kind === 'table')?.rows?.[0]?.[0]).toEqual({
    text: 'Product',
    header: true,
  });
  expect(semantic.blocks.map((b) => b.text).join('\n')).toContain(
    '论文标题：Late-life treatment 查看更多 期刊：Nature “原文” 😀',
  );
});
