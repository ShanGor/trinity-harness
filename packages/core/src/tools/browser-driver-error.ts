import {
  browserCaptureSchema,
  browserUrlSchema,
  type BrowserCapture,
  type BrowserError,
} from '@trinity-harness/contracts';
import { z } from 'zod';

export class BrowserDriverError extends Error {
  constructor(
    readonly code: BrowserError['code'],
    message: string = code,
    readonly recovery?: BrowserError['recovery'],
  ) {
    super(message);
  }
}

/** Classify inadmissible documents before validating canonical evidence. */
export function parseBrowserCapture(value: unknown): BrowserCapture {
  const document = z.object({ url: z.string() }).safeParse(value);
  if (
    document.success &&
    ['chrome-error://chromewebdata/', 'about:blank'].includes(document.data.url)
  )
    throw new BrowserDriverError(
      'PAGE_UNAVAILABLE',
      'The navigation produced a Chrome error or blank document, so this page cannot provide evidence. This does not establish a browser-wide outage. Use a different relevant HTTP(S) source; do not retry the failed navigation automatically.',
      'navigate',
    );
  if (
    document.success &&
    URL.canParse(document.data.url) &&
    !browserUrlSchema.safeParse(document.data.url).success
  ) {
    const url = new URL(document.data.url);
    if (url.username || url.password)
      throw new BrowserDriverError(
        'PRIVACY_DENIED',
        'The current page URL contains credentials and cannot provide browser evidence. Do not alter the URL to bypass this check or expose the credentials. Use another independently authorized public source.',
        'navigate',
      );
    throw new BrowserDriverError(
      'PAGE_UNAVAILABLE',
      'The current document URL is not an admissible bounded HTTP(S) evidence source. This page is unavailable; this does not establish a browser-channel outage. Only a separately authorized HTTP(S) navigation can leave it.',
      'navigate',
    );
  }
  return browserCaptureSchema.parse(value);
}
