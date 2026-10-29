import WebSocket from 'ws';

/**
 * Fun-ASR `/ws` upstream pipe (packages/media-gateway): feeds PCM16 mono
 * 16 kHz frames and surfaces provisional/final results. Mirrors the protocol
 * documented in docs/voice-call-design.md §8.1: 100 ms binary frames, one-time
 * JSON config, `{"is_speaking": false, is_end: true}` flush on finish. The
 * upstream service performs VAD endpointing (`split_silence_ms`).
 */

export interface FunAsrCallbacks {
  onPartial(text: string): void;
  onFinal(text: string): void;
  onError(message: string): void;
  /** The upstream closed the session (error, quota, shutdown). */
  onClose(): void;
}

export interface FunAsrPipeOptions {
  /** Injected for tests; defaults to the `ws` client WebSocket. */
  connect?: (url: string) => WebSocket;
  /** Max ms to wait for the upstream handshake. */
  openTimeoutMs?: number;
}

const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz

export class FunAsrPipe {
  private ws: WebSocket | null = null;
  private readonly pending: number[] = [];
  private closed = false;

  constructor(
    private readonly asrUrl: string,
    private readonly callbacks: FunAsrCallbacks,
    private readonly options: FunAsrPipeOptions = {},
  ) {}

  /** Connect and send the config. False ⇒ upstream unavailable (fail closed). */
  start(): Promise<boolean> {
    const connect = this.options.connect ?? ((url: string) => new WebSocket(url));
    const upstreamUrl = new URL('/ws', this.asrUrl);
    upstreamUrl.protocol = upstreamUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = connect(upstreamUrl.toString());
    this.ws = ws;
    if (ws.readyState !== WebSocket.CONNECTING && ws.readyState !== WebSocket.OPEN) {
      return Promise.resolve(false);
    }

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        try {
          (ws as { terminate?: () => void }).terminate?.();
        } catch {
          // Fake transports in tests may not implement terminate.
        }
        resolve(false);
      }, this.options.openTimeoutMs ?? 10_000);
      const opened = (): void => {
        clearTimeout(timer);
        ws.send(
          JSON.stringify({
            mode: '2pass',
            itn: true,
            diarize: false,
            split_silence_ms: 700,
          }),
        );
        resolve(true);
      };
      ws.on('open', opened);
      ws.on('error', () => {
        clearTimeout(timer);
        resolve(false);
      });
      ws.on('close', () => {
        clearTimeout(timer);
        this.closed = true;
        this.callbacks.onClose();
      });
      ws.on('message', (data: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return;
        let message: {
          is_final?: boolean;
          is_end?: boolean;
          text?: string;
          error?: string;
        };
        try {
          message = JSON.parse(String(data));
        } catch {
          return;
        }
        if (message.error) {
          this.callbacks.onError(message.error);
          return;
        }
        const text = (message.text ?? '').trim();
        if (!text) return;
        if (message.is_final === false) this.callbacks.onPartial(text);
        else if (message.is_final === true && message.is_end !== true) this.callbacks.onFinal(text);
      });
    });
  }

  /** Queue PCM16 mono 16 kHz samples; emits 100 ms binary frames as they fill. */
  writePcm16(samples: Int16Array): void {
    if (this.closed) return;
    for (let i = 0; i < samples.length; i += 1) this.pending.push(samples[i]!);
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (this.pending.length >= FRAME_SAMPLES) {
      const frame = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i += 1) frame[i] = this.pending.shift()!;
      ws.send(frame.buffer);
    }
  }

  /** Flush the tail, signal end-of-input and close. Idempotent. */
  finish(): void {
    if (this.closed) return;
    const ws = this.ws;
    if (ws && ws.readyState === WebSocket.OPEN) {
      if (this.pending.length > 0) {
        ws.send(new Int16Array(this.pending.splice(0)).buffer);
      }
      try {
        ws.send(JSON.stringify({ is_speaking: false, is_end: true }));
      } catch {
        // Closing anyway.
      }
    }
    this.closed = true;
    setTimeout(() => {
      try {
        ws?.close();
      } catch {
        // Already closed.
      }
    }, 4_000);
  }

  /** Close immediately without flushing (session teardown). */
  stop(): void {
    this.closed = true;
    try {
      this.ws?.close();
    } catch {
      // Already closed.
    }
  }
}
