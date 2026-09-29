import { serverEventSchema } from '@trinity-harness/shared';
import type { ServerEvent, SurfaceMessage } from '@trinity-harness/shared';

export interface EventStreamHandle {
  close(): void;
}

export interface AcpClientOptions {
  /** Base URL of the server; '' makes requests same-origin. */
  baseUrl?: string;
  /** Bearer token provider; invoked per request (M2 auth). */
  token?: string | (() => string | null | undefined);
  /** EventSource constructor override (tests / non-browser runtimes). */
  eventSourceFactory?: (url: string) => EventSourceLike;
}

/**
 * Minimal browser-side client for the HTTP+SSE surface.
 *
 * AGENTS.md §4.4: SSE lifecycle (reconnect, backoff, Last-Event-ID, gap
 * detection) lives HERE — UI components must not hand-roll EventSource.
 * M2: the server emits seq ids on the stream, so the client persists the
 * last seen id per session and resumes via `?afterSeq=` (EventSource cannot
 * set headers on reconnect; the query param is the explicit resume path,
 * docs/design.md §11.3). Native reconnects carry Last-Event-ID for free.
 */
export class AcpClient {
  private readonly baseUrl: string;
  private readonly eventSourceFactory: (url: string) => EventSourceLike;
  private readonly token?: string | (() => string | null | undefined);
  /** sessionId → last seen SSE id (seq), for resume after page reloads. */
  private readonly lastSeq = new Map<string, number>();
  /** sessionId → pending reconnect timer, for gap-detect forced reconnects. */
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(opts?: AcpClientOptions) {
    this.baseUrl = opts?.baseUrl ?? '';
    this.token = opts?.token;
    this.eventSourceFactory =
      opts?.eventSourceFactory ?? ((url) => new EventSource(url) as EventSourceLike);
  }

  private authHeaders(): Record<string, string> {
    const token = typeof this.token === 'function' ? this.token() : this.token;
    return token ? { authorization: `Bearer ${token}` } : {};
  }

  private tokenQuery(): string {
    const token = typeof this.token === 'function' ? this.token() : this.token;
    return token ? `&token=${encodeURIComponent(token)}` : '';
  }

  /** Record the newest seq observed for a session (drives future resumes). */
  noteSeq(sessionId: string, seq: number): void {
    const prev = this.lastSeq.get(sessionId) ?? 0;
    if (seq > prev) this.lastSeq.set(sessionId, seq);
  }

  getSeq(sessionId: string): number {
    return this.lastSeq.get(sessionId) ?? 0;
  }

  async createSession(title?: string, policy?: string): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ ...(title ? { title } : {}), ...(policy ? { policy } : {}) }),
    });
    if (!res.ok) {
      throw new Error(`createSession failed: ${res.status}`);
    }
    const body = (await res.json()) as { sessionId: string };
    return body.sessionId;
  }

  async listSessions(): Promise<{ sessionId: string; title: string; createdAt: string }[]> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, { headers: this.authHeaders() });
    if (!res.ok) {
      throw new Error(`listSessions failed: ${res.status}`);
    }
    const body = (await res.json()) as {
      sessions: { sessionId: string; title: string; createdAt: string }[];
    };
    return body.sessions;
  }

  async getMessages(sessionId: string): Promise<SurfaceMessage[]> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/messages`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`getMessages failed: ${res.status}`);
    }
    const body = (await res.json()) as { messages: SurfaceMessage[] };
    return body.messages;
  }

  async sendPrompt(
    sessionId: string,
    text: string,
    attachments?: { uri: string; mimeType: string }[],
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({
        text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
      }),
    });
    if (res.status !== 202) {
      throw new Error(`sendPrompt failed: ${res.status}`);
    }
  }

  /**
   * M4 multimodal: upload an image/PDF attachment (raw octet-stream body).
   * Returns the `blob://` URI to reference from a subsequent prompt.
   */
  async uploadAttachment(
    sessionId: string,
    data: Blob,
    mimeType: string,
    filename?: string,
  ): Promise<{ uri: string; mimeType: string; size: number }> {
    const params = new URLSearchParams({ mime: mimeType });
    if (filename) params.set('filename', filename);
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${sessionId}/attachments?${params.toString()}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', ...this.authHeaders() },
        body: data,
      },
    );
    if (res.status !== 201) {
      throw new Error(`uploadAttachment failed: ${res.status}`);
    }
    return (await res.json()) as { uri: string; mimeType: string; size: number };
  }

  /** Public blob URL for UI rendering (`/api/blobs/<key>` strips blob://). */
  blobUrl(uri: string): string {
    return `${this.baseUrl}/api/blobs/${uri.replace('blob://', '')}`;
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
      onSeq?: (seq: number) => void;
      onError?: (err: unknown) => void;
    },
  ): EventStreamHandle {
    const afterSeq = this.lastSeq.get(sessionId) ?? 0;
    const url = `${this.baseUrl}/api/sessions/${sessionId}/events?afterSeq=${afterSeq}${this.tokenQuery()}`;
    const source = this.eventSourceFactory(url);

    source.onmessage = (msg: { data: unknown; lastEventId?: string }) => {
      try {
        const parsed = serverEventSchema.parse(JSON.parse(String(msg.data)));
        // Native Last-Event-ID handling: seq ids arrive out-of-band.
        const seq = Number(msg.lastEventId);
        if (Number.isInteger(seq) && seq > 0) {
          this.noteSeq(sessionId, seq);
          handlers.onSeq?.(seq);
        }
        handlers.onEvent(parsed);
      } catch (err) {
        handlers.onError?.(err);
      }
    };
    source.onerror = (err: unknown) => {
      handlers.onError?.(err);
      // EventSource auto-reconnects natively (sending Last-Event-ID); the
      // server replays any gap. No manual intervention needed here.
    };
    return {
      close: () => {
        const timer = this.reconnectTimers.get(sessionId);
        if (timer) clearTimeout(timer);
        source.close();
      },
    };
  }

  /** M3: answer a permission request (approval Modal in the web UI). */
  async respondApproval(
    sessionId: string,
    approvalId: string,
    outcome: 'allowed' | 'rejected',
  ): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${sessionId}/approvals/${approvalId}/respond`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ outcome }),
      },
    );
    if (!res.ok) {
      throw new Error(`respondApproval failed: ${res.status}`);
    }
  }

  /** M3: abort the in-flight turn of a session (session/cancel). */
  async cancelTurn(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      throw new Error(`cancelTurn failed: ${res.status}`);
    }
  }

  /** Login against the M2 auth endpoint; returns the bearer token. */
  async login(email: string, password: string): Promise<{ token: string; user: unknown }> {
    const res = await fetch(`${this.baseUrl}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      throw new Error(`login failed: ${res.status}`);
    }
    return (await res.json()) as { token: string; user: unknown };
  }

  /** Admin-only audit query (docs/design.md §13). */
  async queryAudit(query: {
    sessionId?: string;
    action?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ records: unknown[]; total: number }> {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined) params.set(k, String(v));
    }
    const res = await fetch(`${this.baseUrl}/api/audit?${params.toString()}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`queryAudit failed: ${res.status}`);
    }
    return (await res.json()) as { records: unknown[]; total: number };
  }
}

/** Structural subset of EventSource the client relies on. */
export interface EventSourceLike {
  onmessage: ((msg: { data: unknown; lastEventId?: string }) => void) | null;
  onerror: ((err: unknown) => void) | null;
  close(): void;
}
