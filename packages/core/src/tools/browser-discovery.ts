import { createHash } from 'node:crypto';
import { browserUrlSchema, type BrowserResult } from '@trinity-harness/contracts';

type SearchProvider = 'google' | 'bing' | 'duckduckgo';

// Provider URL formats belong to the browser adapter, never the decision loop.
// Unknown sites remain unclassified; query parameters alone establish nothing.
function provider(url: URL): SearchProvider | undefined {
  if (['google.com', 'www.google.com'].includes(url.hostname)) return 'google';
  if (['bing.com', 'www.bing.com'].includes(url.hostname)) return 'bing';
  if (['duckduckgo.com', 'www.duckduckgo.com', 'html.duckduckgo.com'].includes(url.hostname))
    return 'duckduckgo';
  return undefined;
}

function searchProvider(url: URL): SearchProvider | undefined {
  const name = provider(url);
  if (!name || !url.searchParams.get('q')?.trim()) return undefined;
  if (name === 'duckduckgo')
    return ['/', '/html', '/html/'].includes(url.pathname) ? name : undefined;
  return url.pathname === '/search' ? name : undefined;
}

function destination(page: URL, name: SearchProvider | undefined, value: string): URL | null {
  let parsed = browserUrlSchema.safeParse(value);
  if (!parsed.success) return null;
  let url = new URL(parsed.data);
  if (name && provider(url) === name) {
    let redirect: string | null = null;
    if (name === 'google' && url.pathname === '/url')
      redirect = url.searchParams.get('q') ?? url.searchParams.get('url');
    if (name === 'duckduckgo' && url.pathname === '/l/') redirect = url.searchParams.get('uddg');
    if (name === 'bing' && url.pathname === '/ck/a') {
      const encoded = url.searchParams.get('u');
      if (encoded?.startsWith('a1') && /^[A-Za-z0-9_-]+$/.test(encoded.slice(2))) {
        const bytes = Buffer.from(encoded.slice(2), 'base64url');
        if (bytes.toString('base64url') === encoded.slice(2)) redirect = bytes.toString('utf8');
      }
    }
    parsed = browserUrlSchema.safeParse(redirect);
    if (!parsed.success) return null;
    url = new URL(parsed.data);
    // No recursive decoding and no search-provider navigation/chrome destinations.
    if (provider(url) === name) return null;
  }
  if (url.origin === page.origin) return null;
  url.hash = '';
  return url;
}

/** Metadata is advisory. It cannot turn a discovered link into delivered page evidence. */
export function browserDiscovery(
  url: string,
  operation: BrowserResult['operation'],
  links: NonNullable<BrowserResult['links']>,
  complete: boolean,
): BrowserResult['discovery'] {
  const parsed = browserUrlSchema.safeParse(url);
  if (!parsed.success) return undefined;
  const page = new URL(parsed.data);
  const name = searchProvider(page);
  if (!name && operation !== 'web_search') return undefined;
  const keys = new Set<string>();
  for (const link of links.slice(0, 20)) {
    const target = destination(page, name, link.url);
    if (target) keys.add(createHash('sha256').update(target.href).digest('hex'));
  }
  return { kind: 'search', destinationKeys: [...keys], complete: complete && links.length <= 20 };
}
