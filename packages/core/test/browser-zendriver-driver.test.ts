import { describe, expect, it } from 'vitest';
import type { ZendriverClient } from '../src/tools/zendriver-mcp.js';
import { ZendriverBrowserDriver } from '../src/index.js';

/**
 * Zendriver driver state inspection against a scripted MCP client.
 * Covers Chrome's internal error page after a failed navigation (dead proxy,
 * DNS failure): it must surface as a typed PAGE_UNAVAILABLE that only an
 * explicit navigation may recover — never a raw schema error or a spurious
 * STALE_TARGET.
 */

type Page = { tabUrl: string; documentUrl: string };

function fakeClient(pages: Page[]): ZendriverClient {
  let probe = 0;
  return {
    async call(name, args) {
      if (name === 'browser_status') {
        const page = pages[Math.min(probe, pages.length - 1)]!;
        return {
          content: [],
          structuredContent: {
            open: true,
            tab_count: 1,
            current_tab: { id: 'TAB1', url: page.tabUrl },
          },
        };
      }
      if (name === 'browser_evaluate') {
        const page = pages[Math.min(probe++, pages.length - 1)]!;
        return {
          content: [],
          structuredContent: {
            value: {
              url: page.documentUrl,
              documentRevision: '1792716860773_1',
              browserVersion: 'Chrome/155.0.0.0',
            },
          },
        };
      }
      throw new Error(`unexpected call ${name} ${JSON.stringify(args)}`);
    },
  };
}

const sessionId = '00000000-0000-7000-8000-000000000001';
const generation = '00000000-0000-7000-8000-000000000002';
const owner = async (): Promise<boolean> => true;

describe('ZendriverBrowserDriver error pages', () => {
  it.each(['read_page', 'screenshot', 'click', 'web_search', 'navigate'])(
    'reports Chrome error pages as PAGE_UNAVAILABLE for %s without an explicit URL',
    async (operation) => {
      const driver = new ZendriverBrowserDriver(
        fakeClient([
          { tabUrl: 'chrome-error://chromewebdata/', documentUrl: 'chrome-error://chromewebdata/' },
        ]),
        sessionId,
        generation,
        owner,
      );
      await expect(driver.authorize(sessionId, operation, undefined)).rejects.toMatchObject({
        code: 'PAGE_UNAVAILABLE',
        recovery: 'navigate',
      });
    },
  );

  it('keeps session ownership checks before error-page navigation recovery', async () => {
    const driver = new ZendriverBrowserDriver(
      {
        async call() {
          throw new Error('must not inspect an unauthorized browser');
        },
      },
      sessionId,
      generation,
      async () => false,
    );
    await expect(
      driver.authorize(sessionId, 'navigate', 'https://example.com/'),
    ).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
    });
  });

  it('rejects an internal URL as an error-page recovery destination', async () => {
    const driver = new ZendriverBrowserDriver(
      fakeClient([
        { tabUrl: 'chrome-error://chromewebdata/', documentUrl: 'chrome-error://chromewebdata/' },
      ]),
      sessionId,
      generation,
      owner,
    );
    await expect(driver.authorize(sessionId, 'navigate', 'file:///etc/passwd')).rejects.toThrow();
  });

  it('treats a tab-URL/document mismatch on the error page as unavailable, not stale', async () => {
    // The tab keeps the failed destination while the document is the internal
    // error page — this mismatch must not be reported as STALE_TARGET.
    const driver = new ZendriverBrowserDriver(
      fakeClient([
        { tabUrl: 'https://unreachable.example/', documentUrl: 'chrome-error://chromewebdata/' },
      ]),
      sessionId,
      generation,
      owner,
    );
    await expect(driver.authorize(sessionId, 'get_page_text', undefined)).rejects.toMatchObject({
      code: 'PAGE_UNAVAILABLE',
      recovery: 'navigate',
    });
  });

  it('permits an explicit validated navigation away from the error page', async () => {
    const driver = new ZendriverBrowserDriver(
      fakeClient([
        { tabUrl: 'chrome-error://chromewebdata/', documentUrl: 'chrome-error://chromewebdata/' },
      ]),
      sessionId,
      generation,
      owner,
    );
    const binding = await driver.authorize(sessionId, 'navigate', 'https://example.com/');
    expect(binding.observedUrl).toBe('chrome-error://chromewebdata/');
    expect(binding.tabId).toBe('TAB1');
  });

  it('reports an unreachable destination as PAGE_UNAVAILABLE when load waiting reaches Chrome error page', async () => {
    const driver = new ZendriverBrowserDriver(
      {
        async call(name) {
          if (name === 'browser_goto')
            return {
              content: [],
              structuredContent: { url: 'https://unreachable.example/', title: '' },
            };
          if (name === 'browser_wait_for_load') throw new Error('navigation failed');
          if (name === 'browser_status')
            return {
              content: [],
              structuredContent: {
                open: true,
                tab_count: 1,
                current_tab: { id: 'TAB1', url: 'https://unreachable.example/' },
              },
            };
          if (name === 'browser_evaluate')
            return {
              content: [],
              structuredContent: {
                value: {
                  url: 'chrome-error://chromewebdata/',
                  documentRevision: '1792716860773_1',
                  browserVersion: 'Chrome/155.0.0.0',
                },
              },
            };
          throw new Error(`unexpected call ${name}`);
        },
      },
      sessionId,
      generation,
      owner,
    );
    await expect(
      driver.navigate({} as never, 'https://unreachable.example/', {}),
    ).rejects.toMatchObject({ code: 'PAGE_UNAVAILABLE', recovery: 'navigate' });
  });

  it('rejects non-HTTP(S) documents with a typed denial instead of a schema error', async () => {
    const driver = new ZendriverBrowserDriver(
      fakeClient([{ tabUrl: 'file:///etc/passwd', documentUrl: 'file:///etc/passwd' }]),
      sessionId,
      generation,
      owner,
    );
    await expect(driver.authorize(sessionId, 'read_page', undefined)).rejects.toMatchObject({
      code: 'NOT_AUTHORIZED',
      recovery: 'conclude',
    });
  });

  it('accepts a stable document when the two probes race a same-tab URL update', async () => {
    // Post-load history.replaceState: the tab probe saw the old URL while the
    // document probe saw the new one. A stable re-read must not be stale.
    const driver = new ZendriverBrowserDriver(
      fakeClient([
        {
          tabUrl: 'https://example.com/search?q=a',
          documentUrl: 'https://example.com/search?q=a&sei=1',
        },
        {
          tabUrl: 'https://example.com/search?q=a',
          documentUrl: 'https://example.com/search?q=a&sei=1',
        },
      ]),
      sessionId,
      generation,
      owner,
    );
    const binding = await driver.authorize(sessionId, 'read_page', undefined);
    expect(binding.observedUrl).toBe('https://example.com/search?q=a&sei=1');
  });

  it('stays STALE_TARGET when the document keeps moving between probes', async () => {
    const driver = new ZendriverBrowserDriver(
      fakeClient([
        { tabUrl: 'https://example.com/a', documentUrl: 'https://example.com/b' },
        { tabUrl: 'https://example.com/a', documentUrl: 'https://example.com/c' },
      ]),
      sessionId,
      generation,
      owner,
    );
    await expect(driver.authorize(sessionId, 'read_page', undefined)).rejects.toMatchObject({
      code: 'STALE_TARGET',
    });
  });
});
