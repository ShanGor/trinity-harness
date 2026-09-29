import type { LongRunningProcess } from '@trinity-harness/contracts';

/**
 * Minimal LSP stdio transport: Content-Length-framed JSON-RPC 2.0 over the
 * raw byte duplex (docs/design.md §9). One reader loop parses frames and
 * dispatches responses / notifications; requests get a monotonically
 * increasing id and a pending map.
 */

export interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export class LspConnection {
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (err: Error) => void }
  >();
  private readonly notificationHandlers = new Map<string, Array<(params: unknown) => void>>();
  private buffer = Buffer.alloc(0);
  private readerDone: Promise<void>;
  private failed: Error | null = null;

  constructor(private readonly proc: LongRunningProcess) {
    this.readerDone = this.readLoop();
    void this.readerDone.catch(() => {});
    void proc.exited.then(() => {
      const err = new Error('language server process exited');
      this.failed = err;
      for (const { reject } of this.pending.values()) reject(err);
      this.pending.clear();
    });
  }

  onNotification(method: string, handler: (params: unknown) => void): void {
    const list = this.notificationHandlers.get(method) ?? [];
    list.push(handler);
    this.notificationHandlers.set(method, list);
  }

  async request<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.failed) throw this.failed;
    const id = this.nextId++;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', id, method, params }), 'utf8');
    const frame = Buffer.from(
      `Content-Length: ${payload.byteLength}\r\n\r\n${payload.toString('utf8')}`,
      'utf8',
    );
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`LSP request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value as T);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      this.proc.write(frame);
    });
  }

  notify(method: string, params: unknown): void {
    const payload = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params }), 'utf8');
    const frame = Buffer.from(
      `Content-Length: ${payload.byteLength}\r\n\r\n${payload.toString('utf8')}`,
      'utf8',
    );
    this.proc.write(frame);
  }

  private async readLoop(): Promise<void> {
    for await (const chunk of this.proc.chunks()) {
      this.buffer =
        this.buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this.buffer, chunk]);
      for (;;) {
        const frame = this.takeFrame();
        if (frame === null) break;
        this.dispatch(JSON.parse(frame.toString('utf8')) as JsonRpcMessage);
      }
    }
  }

  /** Parses one Content-Length-framed message; null when more bytes are needed. */
  private takeFrame(): Buffer | null {
    const headerEnd = this.buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) return null;
    const header = this.buffer.subarray(0, headerEnd).toString('utf8');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) {
      // Garbage on the wire — drop the header bytes and resync.
      this.buffer = this.buffer.subarray(headerEnd + 4);
      return null;
    }
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (this.buffer.length < bodyStart + length) return null;
    const body = this.buffer.subarray(bodyStart, bodyStart + length);
    this.buffer = this.buffer.subarray(bodyStart + length);
    return body;
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
      const pending = this.pending.get(Number(msg.id));
      if (pending) {
        this.pending.delete(Number(msg.id));
        if (msg.error) {
          pending.reject(new Error(`LSP error ${msg.error.code}: ${msg.error.message}`));
        } else {
          pending.resolve(msg.result);
        }
      }
      return;
    }
    if (msg.method && msg.id !== undefined) {
      // Server→client request (e.g. window/workDoneProgress/create from a
      // real language server). We declare no such capabilities, but must
      // still answer — an unanswered request can stall the server — so reply
      // with a null result (JSON-RPC 2.0 §4.1 / LSP base protocol).
      const payload = Buffer.from(
        JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: null }),
        'utf8',
      );
      this.proc.write(
        Buffer.from(
          `Content-Length: ${payload.byteLength}\r\n\r\n${payload.toString('utf8')}`,
          'utf8',
        ),
      );
      return;
    }
    if (msg.method) {
      for (const handler of this.notificationHandlers.get(msg.method) ?? []) {
        try {
          handler(msg.params);
        } catch {
          // Notification handlers must not break the reader loop.
        }
      }
    }
  }
}
