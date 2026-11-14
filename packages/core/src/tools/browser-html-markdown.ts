import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { z } from 'zod';
import { BrowserDriverError } from './browser-driver-error.js';

const require = createRequire(import.meta.url);
const versionSchema = z.object({ version: z.string().min(1).max(40) });
export const browserHtmlConverterVersion = `turndown@${versionSchema.parse(require('turndown/package.json')).version}+gfm@${versionSchema.parse(require('turndown-plugin-gfm/package.json')).version}`;
const resultSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('markdown'),
    text: z.string(),
    warnings: z.boolean(),
    warningCodes: z.array(z.enum(['inline-svg', 'unsupported-table', 'layout-html'])).max(3),
  }),
  z.object({ kind: z.literal('limit') }),
]);
export const browserHtmlConverterOptions = {
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  svgRepresentation: 'inert-inline-html-v1',
} as const;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const workerScript = `
const { parentPort, workerData } = require('node:worker_threads');
const TurndownService = require(workerData.turndown);
const { gfm } = require(workerData.gfm);
let warnings = false;
const warningCodes = new Set();
const svgHtml = node => { warnings = true; warningCodes.add('inline-svg'); return '\\n\\n' + node.outerHTML + '\\n\\n'; };
const service = new TurndownService({...workerData.options,
  blankReplacement(_content, node) { return (node.nodeName.toLowerCase() === 'svg' || node.querySelector?.('svg')) ? svgHtml(node) : node.isBlock ? '\\n\\n' : ''; }
});
service.use(gfm);
service.addRule('capturedSvg', { filter: node => node.nodeName.toLowerCase() === 'svg', replacement: (_content, node) => svgHtml(node) });
// GFM cannot represent merged cells or tables without a heading row. Retain
// those tables as inert HTML rather than flattening or silently losing cells.
service.addRule('unsupportedTables', {
  filter(node) {
    if (node.nodeName !== 'TABLE') return false;
    const row = node.querySelector('tr');
    return !!node.querySelector('[rowspan], [colspan]') || !row ||
      !(row.parentNode.nodeName === 'THEAD' || Array.from(row.children).every(cell => cell.nodeName === 'TH'));
  },
  replacement(_content, node) { warnings = true; warningCodes.add('unsupported-table'); return '\\n\\n' + node.outerHTML + '\\n\\n'; }
});
// CSS grid cells may be spans with computed display:block. Turndown's tag-only
// rules concatenate them. Preserve their captured inert layout without inventing
// table headers/rows from pixel geometry or changing the immutable HTML input.
service.addRule('capturedGrid', {
  filter(node) {
    return ['grid', 'inline-grid'].includes(node.style?.display) &&
      Array.from(node.children).some(child => child.nodeName === 'SPAN' && child.style?.display === 'block');
  },
  replacement(_content, node) { warnings = true; warningCodes.add('layout-html'); return '\\n\\n' + node.outerHTML + '\\n\\n'; }
});
const text = service.turndown(workerData.html) + '\\n';
parentPort.postMessage(Buffer.byteLength(text) > workerData.maxOutputBytes
  ? { kind: 'limit' } : { kind: 'markdown', text, warnings, warningCodes: [...warningCodes] });
`;

/** Pure offline conversion; a disposable worker bounds CPU time and isolates parser memory. */
export async function browserHtmlToMarkdown(
  html: string,
  signal?: AbortSignal,
): Promise<{
  text: string;
  warnings: boolean;
  warningCodes: ('inline-svg' | 'unsupported-table' | 'layout-html')[];
}> {
  signal?.throwIfAborted();
  if (Buffer.byteLength(html) > 16 * 1024 * 1024)
    throw new BrowserDriverError('LIMIT_REACHED', 'Saved HTML exceeds the conversion input limit.');
  const active = AbortSignal.any([AbortSignal.timeout(30_000), ...(signal ? [signal] : [])]);
  const worker = new Worker(workerScript, {
    eval: true,
    // This fixed CommonJS worker must not inherit application/test loader flags.
    execArgv: [],
    workerData: {
      html,
      turndown: require.resolve('turndown'),
      gfm: require.resolve('turndown-plugin-gfm'),
      maxOutputBytes: MAX_OUTPUT_BYTES,
      options: browserHtmlConverterOptions,
    },
    resourceLimits: { maxOldGenerationSizeMb: 256, stackSizeMb: 4 },
  });
  let abort: () => void = () => undefined;
  try {
    return await new Promise((resolve, reject) => {
      abort = (): void =>
        reject(
          new BrowserDriverError(
            signal?.aborted ? 'CANCELLED' : 'LIMIT_REACHED',
            'HTML conversion was cancelled or exceeded its execution limit. Saved HTML remains available.',
          ),
        );
      active.addEventListener('abort', abort, { once: true });
      if (active.aborted) abort();
      worker.once('message', (value: unknown) => {
        const parsed = resultSchema.safeParse(value);
        if (!parsed.success) reject(new BrowserDriverError('INVALID_OUTPUT'));
        else if (
          parsed.data.kind === 'limit' ||
          Buffer.byteLength(parsed.data.text) > MAX_OUTPUT_BYTES
        )
          reject(
            new BrowserDriverError(
              'LIMIT_REACHED',
              'Markdown exceeds the conversion output limit.',
            ),
          );
        else
          resolve({
            text: parsed.data.text,
            warnings: parsed.data.warnings,
            warningCodes: parsed.data.warningCodes,
          });
      });
      worker.once('error', () =>
        reject(
          new BrowserDriverError(
            'NOT_EXECUTED',
            'Turndown conversion failed. Saved HTML remains available.',
          ),
        ),
      );
      worker.once('exit', () =>
        reject(
          new BrowserDriverError(
            'NOT_EXECUTED',
            'HTML converter exited before returning a result. Saved HTML remains available.',
          ),
        ),
      );
    });
  } finally {
    active.removeEventListener('abort', abort);
    await worker.terminate();
  }
}
