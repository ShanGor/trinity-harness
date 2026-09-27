import { serverEventSchema } from '@trinity-harness/shared';
import type { ServerEvent, SurfaceMessage } from '@trinity-harness/shared';

export interface EventStreamHandle {
  close(): void;
}

export interface AcpClientOptions {
  /** Base URL of the server; '' makes requests same-origin. */
  baseUrl?: string;
  /** EventSource constructor override (tests / non-browser runtimes). */
  eventSourceFactory?: (url: string) => EventSourceLike;
}

/**
 * Minimal browser-side client for the M1 HTTP+SSE surface.
 *
 * AGENTS.md §4.4: SSE lifecycle (reconnect, backoff, Last-Event-ID, gap
 * detection) lives HERE — UI components must not hand-roll EventSource.
 * M1 note: the browser reconnects natively; seq-based resume lands in M3
 * together with the official ACP HTTP binding.
 */
export class AcpClient {
  private readonly baseUrl: string;
  private readonly eventSourceFactory: (url: string) => EventSourceLike;

  constructor(opts?: AcpClientOptions) {
    this.baseUrl = opts?.baseUrl ?? '';
    this.eventSourceFactory =
      opts?.eventSourceFactory ?? ((url) => new EventSource(url) as EventSourceLike);
  }

  async createSession(title?: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(title ? { title } : {}),
    });
    if (!res.ok) {
      throw new Error(`createSession failed: ${res.status}`);
    }
    const body = (await res.json()) as { sessionId: string };
    return body.sessionId;
  }

  async getMessages(sessionId: string): Promise<SurfaceMessage[]> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/messages`);
    if (!res.ok) {
      throw new Error(`getMessages failed: ${res.status}`);
    }
    const body = (await res.json()) as { messages: SurfaceMessage[] };
    return body.messages;
  }

  async sendPrompt(sessionId: string, text: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text }),
    });
    if (res.status !== 202) {
      throw new Error(`sendPrompt failed: ${res.status}`);
    }
  }

  /**
   * Subscribe to session events. Events are validated against the shared zod
   * schema at the boundary; malformed payloads are reported via onError and
   * dropped (never thrown into the UI).
   */
  openEventStream(
    sessionId: string,
    handlers: {
      onEvent: (event: ServerEvent) => void;
      onError?: (err: unknown) => void;
    },
  ): EventStreamHandle {
    const source = this.eventSourceFactory(`${this.baseUrl}/api/sessions/${sessionId}/events`);
    source.onmessage = (msg: { data: unknown }) => {
      try {
        const parsed = serverEventSchema.parse(JSON.parse(String(msg.data)));
        handlers.onEvent(parsed);
      } catch (err) {
        handlers.onError?.(err);
      }
    };
    source.onerror = (err: unknown) => {
      handlers.onError?.(err);
      // EventSource auto-reconnects; the M1 server keeps unnamed events so
      // no resume logic is required until M3.
    };
    return {
      close: () => source.close(),
    };
  }
}

/** Structural subset of EventSource the client relies on. */
export interface EventSourceLike {
  onmessage: ((msg: { data: unknown }) => void) | null;
  onerror: ((err: unknown) => void) | null;
  close(): void;
}
