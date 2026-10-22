import { z } from 'zod';
import { BROWSER_LIMITS, type LongRunningProcess } from '@trinity-harness/contracts';
import { BrowserDriverError } from './browser-driver-error.js';

export const ZENDRIVER_VERSION = '0.16.37';
export const ZENDRIVER_REVISION = '5b3e94986693d02bfeb819f96d59acb4e41107ef';
const wire = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.union([z.number(), z.string()]).optional(),
  method: z.string().optional(),
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});
const toolResult = z.object({
  isError: z.boolean().optional(),
  structuredContent: z.unknown().optional(),
  content: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('text'), text: z.string() }),
        z.object({ type: z.literal('image'), data: z.string(), mimeType: z.string() }),
      ]),
    )
    .max(8),
});
export type ZendriverToolResult = z.infer<typeof toolResult>;
export interface ZendriverClient {
  call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    image?: boolean,
  ): Promise<ZendriverToolResult>;
}

/** Bounded MCP NDJSON transport. The supervisor serializes requests per browser. */
export class ZendriverMcpConnection implements ZendriverClient {
  private nextId = 1;
  private failed = false;
  private buffer = Buffer.alloc(0);
  private readonly reader: Promise<void>;
  private pending?: {
    id: number;
    limit: number;
    diagnostics: number;
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  };

  constructor(private readonly process: LongRunningProcess) {
    this.reader = this.read().catch(() => {
      this.fail();
    });
    void process.exited.then(
      () => this.fail(),
      () => this.fail(),
    );
  }
  private fail(): void {
    if (this.failed) return;
    this.failed = true;
    this.buffer = Buffer.alloc(0);
    this.pending?.reject(new BrowserDriverError('DRIVER_FAILED'));
    this.pending = undefined;
    this.process.kill();
  }
  private send(value: unknown): void {
    this.process.write(Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'));
  }
  private async request(
    method: string,
    params: unknown,
    signal?: AbortSignal,
    limit: number = BROWSER_LIMITS.transport,
  ): Promise<unknown> {
    signal?.throwIfAborted();
    if (this.failed || this.pending) throw new BrowserDriverError('DRIVER_FAILED');
    const id = this.nextId++;
    const deadline = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]);
    return await new Promise<unknown>((resolve, reject) => {
      const cleanup = (): void => deadline.removeEventListener('abort', abort);
      const abort = (): void => {
        try {
          this.send({
            jsonrpc: '2.0',
            method: 'notifications/cancelled',
            params: { requestId: id, reason: 'cancelled' },
          });
        } finally {
          this.fail();
        }
      };
      this.pending = {
        id,
        limit,
        diagnostics: 0,
        resolve: (value) => {
          cleanup();
          this.pending = undefined;
          resolve(value);
        },
        reject: (err) => {
          cleanup();
          this.pending = undefined;
          reject(err);
        },
      };
      deadline.addEventListener('abort', abort, { once: true });
      try {
        this.send({ jsonrpc: '2.0', id, method, params });
      } catch {
        this.fail();
      }
      if (deadline.aborted) abort();
    });
  }
  async initialize(signal?: AbortSignal): Promise<void> {
    // This upstream release reports rmcp's identity; pin the executable separately at startup.
    const result = z
      .object({
        protocolVersion: z.enum(['2025-06-18', '2025-03-26', '2024-11-05']),
        serverInfo: z.object({ name: z.literal('rmcp'), version: z.literal('2.2.0') }),
        capabilities: z.object({ tools: z.object({}).optional() }),
      })
      .parse(
        await this.request(
          'initialize',
          {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'trinity-browser', version: '1' },
          },
          signal,
        ),
      );
    if (!result.capabilities.tools) throw new BrowserDriverError('DISABLED');
    this.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  }
  async call(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    image = false,
  ): Promise<ZendriverToolResult> {
    const result = toolResult.parse(
      await this.request(
        'tools/call',
        { name, arguments: args },
        signal,
        image ? Math.ceil((BROWSER_LIMITS.image * 4) / 3) + 4096 : BROWSER_LIMITS.transport,
      ),
    );
    if (result.isError) throw new BrowserDriverError('DRIVER_FAILED');
    return result;
  }
  private async read(): Promise<void> {
    for await (const chunk of this.process.chunks()) {
      let offset = 0;
      while (offset < chunk.length) {
        const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        const newline = bytes.indexOf(10, offset);
        const end = newline < 0 ? bytes.length : newline;
        const limit = this.pending?.limit ?? BROWSER_LIMITS.diagnostic;
        if (this.buffer.length + end - offset > limit) {
          this.pending?.reject(new BrowserDriverError('TRANSPORT_OVERFLOW'));
          this.fail();
          return;
        }
        this.buffer = Buffer.concat([this.buffer, bytes.subarray(offset, end)]);
        offset = end + 1;
        if (newline < 0) break;
        if (this.buffer.length === 0) continue;
        const message = wire.parse(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(this.buffer)),
        );
        const length = this.buffer.length;
        this.buffer = Buffer.alloc(0);
        if (message.id === this.pending?.id && !message.method) {
          if ('error' in message) this.pending?.reject(new BrowserDriverError('DRIVER_FAILED'));
          else if ('result' in message) this.pending?.resolve(message.result);
          else throw new BrowserDriverError('INVALID_OUTPUT');
        } else if (message.method && message.id !== undefined) {
          this.send(
            message.method === 'ping'
              ? { jsonrpc: '2.0', id: message.id, result: {} }
              : {
                  jsonrpc: '2.0',
                  id: message.id,
                  error: { code: -32601, message: 'Unsupported method' },
                },
          );
        } else {
          if (this.pending) {
            this.pending.diagnostics += length;
            if (this.pending.diagnostics > BROWSER_LIMITS.diagnostic)
              throw new BrowserDriverError('TRANSPORT_OVERFLOW');
          }
        }
      }
    }
    this.fail();
  }
  async dispose(): Promise<void> {
    this.fail();
    await Promise.all([this.process.exited, this.reader]);
  }
}

export function zendriverStructured(result: ZendriverToolResult): unknown {
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (result.content.length !== 1 || result.content[0]?.type !== 'text')
    throw new BrowserDriverError('INVALID_OUTPUT');
  return JSON.parse(result.content[0].text) as unknown;
}
