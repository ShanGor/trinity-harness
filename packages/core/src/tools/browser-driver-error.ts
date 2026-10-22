import type { BrowserError } from '@trinity-harness/contracts';

export class BrowserDriverError extends Error {
  constructor(
    readonly code: BrowserError['code'],
    message: string = code,
    readonly recovery?: BrowserError['recovery'],
  ) {
    super(message);
  }
}
