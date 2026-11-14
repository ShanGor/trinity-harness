import { describe, expect, it } from 'vitest';
import { browserDiscovery } from '../src/tools/browser-discovery.js';

const links = (urls: string[]) => urls.map((url) => ({ blockId: 'b0', title: 'Source', url }));
const keyFor = (url: string) =>
  browserDiscovery('https://www.google.com/search?q=test', 'web_search', links([url]), true)!
    .destinationKeys;

describe('browser discovery metadata', () => {
  it('identifies equivalent typed and navigated searches without inspecting query text', () => {
    const urls = ['https://docs.example.org/spec#one', 'https://docs.example.org/spec#two'];
    const typed = browserDiscovery(
      'https://www.google.com/search?q=资料',
      'web_search',
      links(urls),
      true,
    );
    for (const page of [
      'https://www.google.com/search?q=different',
      'https://www.bing.com/search?q=other',
      'https://html.duckduckgo.com/html/?q=anything',
    ])
      expect(browserDiscovery(page, 'navigate', links(urls), true)).toEqual(typed);
    expect(typed?.destinationKeys).toHaveLength(1);
    expect(JSON.stringify(typed)).not.toContain('docs.example.org');
  });

  it.each([
    ['https://html.duckduckgo.com/html/?q=x', 'https://duckduckgo.com/l/?uddg='],
    ['https://www.google.com/search?q=x', 'https://www.google.com/url?q='],
  ])(
    'compares known redirect destinations on %s without changing the observed link',
    (page, prefix) => {
      const target = 'https://source.example.org/article?version=2#part';
      const observed = links([prefix + encodeURIComponent(target)]);
      const original = structuredClone(observed);
      expect(browserDiscovery(page, 'navigate', observed, true)?.destinationKeys).toEqual(
        keyFor(target),
      );
      expect(observed).toEqual(original);
    },
  );

  it('handles the bounded Bing redirect format', () => {
    const target = 'https://source.example.org/article';
    expect(
      browserDiscovery(
        'https://www.bing.com/search?q=x',
        'navigate',
        links([`https://www.bing.com/ck/a?u=a1${Buffer.from(target).toString('base64url')}`]),
        true,
      )?.destinationKeys,
    ).toEqual(keyFor(target));
  });

  it('does not treat arbitrary query pages or deceptive hostnames as search pages', () => {
    for (const page of [
      'https://shop.example.org/search?q=test',
      'https://www.google.com.evil.example/search?q=test',
      'https://www.google.com/preferences?q=test',
      'https://www.bing.com/search',
      'https://html.duckduckgo.com/html/?q=',
      'https://user:password@www.google.com/search?q=x',
    ])
      expect(
        browserDiscovery(page, 'navigate', links(['https://source.example.org']), true),
      ).toBeUndefined();
  });

  it('rejects internal controls, invalid redirects and credentials without decoding unknown formats', () => {
    const invalid = [
      'https://duckduckgo.com/feedback.html',
      'https://html.duckduckgo.com/html/?q=other',
      ...[
        'javascript:alert(1)',
        'file:///private',
        'https://user:secret@source.example.org/',
        'https://source.example.org/' + 'x'.repeat(2000),
        'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fsource.example.org',
      ].map((value) => 'https://duckduckgo.com/l/?uddg=' + encodeURIComponent(value)),
    ];
    expect(
      browserDiscovery('https://html.duckduckgo.com/html/?q=x', 'navigate', links(invalid), true)
        ?.destinationKeys,
    ).toEqual([]);
    expect(
      browserDiscovery(
        'https://www.google.com/search?q=x',
        'navigate',
        links(['https://www.google.com/unknown?url=https%3A%2F%2Fsource.example.org']),
        true,
      )?.destinationKeys,
    ).toEqual([]);
    expect(
      browserDiscovery(
        'https://www.bing.com/search?q=x',
        'navigate',
        links(['https://www.bing.com/ck/a?u=a1???']),
        true,
      )?.destinationKeys,
    ).toEqual([]);
  });

  it('preserves incomplete and empty observations without interpreting their meaning', () => {
    expect(browserDiscovery('https://www.google.com/search?q=x', 'navigate', [], false)).toEqual({
      kind: 'search',
      destinationKeys: [],
      complete: false,
    });
    expect(browserDiscovery('https://www.google.com/search?q=x', 'navigate', [], true)).toEqual({
      kind: 'search',
      destinationKeys: [],
      complete: true,
    });
  });
});
