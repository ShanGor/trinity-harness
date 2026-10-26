import { describe, expect, it, vi } from 'vitest';
import { BROWSER_LIMITS, type LongRunningProcess } from '@trinity-harness/contracts';
import { ZendriverMcpConnection } from '../src/index.js';

class Process implements LongRunningProcess {
  readonly writes: Array<Record<string, unknown>> = [];
  kills = 0;
  private stopped = false;
  private queue: Array<Uint8Array | null> = [];
  private waiting?: (value: Uint8Array | null) => void;
  private exit!: (value: number | null) => void;
  readonly exited = new Promise<number | null>((resolve) => {
    this.exit = resolve;
  });
  constructor(
    private readonly handler: (message: Record<string, unknown>, process: Process) => void,
  ) {}
  write(bytes: Uint8Array): void {
    const message = JSON.parse(Buffer.from(bytes).toString()) as Record<string, unknown>;
    this.writes.push(message);
    this.handler(message, this);
  }
  push(bytes: Uint8Array | null): void {
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve(bytes);
    } else this.queue.push(bytes);
  }
  respond(id: unknown, result: unknown): void {
    const payload = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
    // Split in the middle of UTF-8 content and JSON tokens.
    for (let i = 0; i < payload.length; i += 7) this.push(payload.subarray(i, i + 7));
  }
  async *chunks(): AsyncIterable<Uint8Array> {
    for (;;) {
      const value = this.queue.length
        ? this.queue.shift()!
        : await new Promise<Uint8Array | null>((resolve) => {
            this.waiting = resolve;
          });
      if (value === null) break;
      yield value;
    }
  }
  kill(): void {
    if (!this.stopped) {
      this.stopped = true;
      this.kills++;
      this.push(null);
      this.exit(0);
    }
  }
}
const initialize = {
  protocolVersion: '2025-06-18',
  serverInfo: { name: 'rmcp', version: '2.2.0' },
  capabilities: { tools: {} },
};
describe('bounded Zendriver MCP transport', () => {
  it('handles fragmented Unicode responses and initialization without exposing server tools', async () => {
    const process = new Process((message, p) => {
      if (message.id)
        p.respond(
          message.id,
          message.method === 'initialize'
            ? initialize
            : {
                content: [{ type: 'text', text: '{"value":"世界😀"}' }],
                structuredContent: { value: '世界😀' },
              },
        );
    });
    const connection = new ZendriverMcpConnection(process);
    await connection.initialize();
    expect(
      (await connection.call('browser_evaluate', { expression: 'fixed-script' })).structuredContent,
    ).toEqual({ value: '世界😀' });
    expect(process.writes.map((m) => m.method)).toEqual([
      'initialize',
      'notifications/initialized',
      'tools/call',
    ]);
    await connection.dispose();
    expect(process.kills).toBe(1);
  });
  it('rejects oversize frames before parsing and kills the process', async () => {
    const process = new Process((message, p) => {
      if (message.id) p.push(Buffer.alloc(BROWSER_LIMITS.transport + 1, 120));
    });
    const connection = new ZendriverMcpConnection(process);
    await expect(connection.initialize()).rejects.toMatchObject({ code: 'TRANSPORT_OVERFLOW' });
    expect(process.kills).toBe(1);
    await connection.dispose();
  });
  it('rejects malformed NDJSON and all pending work on premature exit', async () => {
    for (const malformed of [true, false]) {
      const process = new Process((message, p) => {
        if (message.id) {
          if (malformed) p.push(Buffer.from('not-json\n'));
          else p.kill();
        }
      });
      const connection = new ZendriverMcpConnection(process);
      await expect(connection.initialize()).rejects.toMatchObject({ code: 'DRIVER_FAILED' });
      await connection.dispose();
    }
  });
  it('sends cancellation and terminates the owned process instead of assuming cancellation succeeded', async () => {
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const process = new Process((message) => {
      if (message.id) entered();
    });
    const connection = new ZendriverMcpConnection(process);
    const controller = new AbortController();
    const result = connection.initialize(controller.signal);
    await started;
    controller.abort();
    await expect(result).rejects.toMatchObject({
      code: 'DRIVER_FAILED',
      message: 'DRIVER_FAILED',
    });
    expect(process.writes.some((m) => m.method === 'notifications/cancelled')).toBe(true);
    expect(process.kills).toBe(1);
    await connection.dispose();
  });
  it('preserves a safe timeout explanation while cancelling and disposing the driver', async () => {
    const timeout = new AbortController();
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
    const process = new Process((message, p) => {
      if (message.method === 'initialize') p.respond(message.id, initialize);
    });
    const connection = new ZendriverMcpConnection(process);
    try {
      await connection.initialize();
      const result = connection.call('browser_goto', {
        url: 'https://private.invalid/?token=must-not-appear',
      });
      const rejected = expect(result).rejects.toMatchObject({
        code: 'DRIVER_FAILED',
        message:
          'The browser driver did not respond within 30 seconds. Its process was stopped; the operation may have taken effect. Check the browser runtime and host-managed guest egress before retrying.',
        recovery: 'conclude',
      });
      expect(deadline).toHaveBeenCalledWith(30_000);
      timeout.abort();
      await rejected;
      expect(process.writes.at(-1)).toMatchObject({
        method: 'notifications/cancelled',
        params: { requestId: 2, reason: 'cancelled' },
      });
      expect(process.kills).toBe(1);
    } finally {
      deadline.mockRestore();
      await connection.dispose();
    }
  });
  it('rejects unsupported server requests without sampling or executing them', async () => {
    const process = new Process((message, p) => {
      if (message.method === 'initialize') {
        p.push(
          Buffer.from(
            `${JSON.stringify({ jsonrpc: '2.0', id: 'server-request', method: 'sampling/createMessage', params: {} })}\n`,
          ),
        );
        p.respond(message.id, initialize);
      }
    });
    const connection = new ZendriverMcpConnection(process);
    await connection.initialize();
    expect(process.writes.find((m) => m.id === 'server-request')).toMatchObject({
      error: { code: -32601 },
    });
    await connection.dispose();
  });
});
