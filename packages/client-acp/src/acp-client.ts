import {
  newId,
  personalFoldersResponseSchema,
  serverEventSchema,
  turnCancelResponseSchema,
  memorySnapshotSchema,
  sessionSummaryListSchema,
  sessionSettingsSchema,
  sessionPolicyUpdateSchema,
  sessionPolicyUpdateResponseSchema,
  historyPageSchema,
  memorySelectionsResponseSchema,
  timelinePageSchema,
  browserPreviewSchema,
  browserInteractionRequestSchema,
  browserInteractionResultSchema,
  scheduleListSchema,
  inboxListSchema,
  environmentResponseSchema,
} from '@trinity-harness/shared';
import type {
  ServerEvent,
  SurfaceMessage,
  WorkspaceSelection,
  TurnCancelResponse,
  MemoryCommand,
  MemorySnapshot,
  HistoryPage,
  MemorySelectionsResponse,
  TimelinePage,
  SessionSummary,
  SessionSettings,
  HistoryQuery,
  BrowserPreview,
  BrowserInteractionRequest,
  BrowserInteractionResult,
  ScheduleCreate,
  ScheduleRecord,
} from '@trinity-harness/shared';

export type { WorkspaceSelection } from '@trinity-harness/shared';

export interface EventStreamHandle {
  close(): void;
}

export type { SessionSummary } from '@trinity-harness/shared';

export interface TeamMemberView {
  userId: string;
  email: string;
  role: 'owner' | 'member';
  createdAt: string;
}

export interface TeamView {
  teamId: string;
  name: string;
  createdAt: string;
  members: TeamMemberView[];
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

  /** One bounded user-view capture; never requests or grants browser input. */
  async getBrowserPreview(sessionId: string, signal?: AbortSignal): Promise<BrowserPreview> {
    const response = await fetch(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/browser-preview`,
      {
        headers: this.authHeaders(),
        cache: 'no-store',
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(10_000)]),
      },
    );
    if (!response.ok) throw new Error(`Browser preview unavailable (${response.status})`);
    return browserPreviewSchema.parse(await response.json());
  }
  async interactBrowser(
    input: BrowserInteractionRequest,
    signal?: AbortSignal,
  ): Promise<BrowserInteractionResult> {
    const { sessionId, ...body } = browserInteractionRequestSchema.parse(input);
    const response = await fetch(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/browser-interaction`,
      {
        method: 'POST',
        headers: { ...this.authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(body),
        cache: 'no-store',
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(70_000)]),
      },
    );
    if (!response.ok)
      throw Object.assign(new Error(`Browser interaction unavailable (${response.status})`), {
        status: response.status,
      });
    return browserInteractionResultSchema.parse(await response.json());
  }
  async getSchedules(): Promise<ReturnType<typeof scheduleListSchema.parse>> {
    return scheduleListSchema.parse(await this.assistantRequest('/api/schedules'));
  }
  async getEnvironment(
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof environmentResponseSchema.parse>> {
    return environmentResponseSchema.parse(
      await this.assistantRequest(
        '/api/me/environment',
        'GET',
        undefined,
        AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
      ),
    );
  }
  async changeEnvironment(
    action: 'wake' | 'suspend',
    signal?: AbortSignal,
  ): Promise<ReturnType<typeof environmentResponseSchema.parse>> {
    return environmentResponseSchema.parse(
      await this.assistantRequest(`/api/me/environment/${action}`, 'POST', {}, signal),
    );
  }
  async createSchedule(input: ScheduleCreate): Promise<void> {
    await this.assistantRequest('/api/schedules', 'POST', input);
  }
  async setScheduleEnabled(schedule: ScheduleRecord, enabled: boolean): Promise<void> {
    await this.assistantRequest(`/api/schedules/${schedule.id}`, 'PATCH', {
      revision: schedule.revision,
      enabled,
    });
  }
  async getInbox(signal?: AbortSignal): Promise<ReturnType<typeof inboxListSchema.parse>> {
    return inboxListSchema.parse(
      await this.assistantRequest('/api/inbox', 'GET', undefined, signal),
    );
  }
  async acknowledgeNotification(id: string): Promise<void> {
    await this.assistantRequest(`/api/inbox/${id}/ack`, 'POST', {});
  }

  async createSession(
    title?: string,
    policy?: string,
    workspace?: WorkspaceSelection,
    options?: {
      kind: 'chat' | 'work';
      sessionRole?: 'main' | 'side' | 'task';
      creationOperationId: string;
      originSessionId?: string;
    },
  ): Promise<string> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({
        ...options,
        ...(title ? { title } : {}),
        ...(policy ? { policy } : {}),
        ...(workspace ? { workspace } : {}),
      }),
    });
    if (!res.ok) {
      throw Object.assign(new Error(`createSession failed: ${res.status}`), { status: res.status });
    }
    const body = (await res.json()) as { sessionId: string };
    return body.sessionId;
  }

  async ensureMainChat(): Promise<string> {
    return this.createSession('Main chat', 'workspace-write', undefined, {
      kind: 'chat',
      sessionRole: 'main',
      creationOperationId: newId(),
    });
  }

  private async assistantRequest(
    path: string,
    method = 'GET',
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    return res.json();
  }
  async getMemory(): Promise<MemorySnapshot> {
    return memorySnapshotSchema.parse(await this.assistantRequest('/api/memory'));
  }
  async changeMemory(command: MemoryCommand): Promise<void> {
    await this.assistantRequest('/api/memory', 'POST', command);
  }
  async getHistory(query: Partial<HistoryQuery> = {}): Promise<HistoryPage> {
    const params = new URLSearchParams(
      Object.entries(query)
        .filter(([, value]) => value !== undefined)
        .map(([key, value]) => [key, String(value)]),
    );
    return historyPageSchema.parse(await this.assistantRequest(`/api/history?${params}`));
  }

  async reviseEpisode(id: string, change: { topic?: string; excluded?: boolean }): Promise<void> {
    await this.assistantRequest(`/api/history/${encodeURIComponent(id)}`, 'PATCH', change);
  }
  async getMemorySelections(id: string): Promise<MemorySelectionsResponse> {
    return memorySelectionsResponseSchema.parse(
      await this.assistantRequest(`/api/sessions/${id}/memory`),
    );
  }

  async listSessions(): Promise<SessionSummary[]> {
    const res = await fetch(`${this.baseUrl}/api/sessions`, { headers: this.authHeaders() });
    if (!res.ok) {
      throw new Error(`listSessions failed: ${res.status}`);
    }
    const body = sessionSummaryListSchema.parse(await res.json());
    return body.sessions;
  }

  async getSessionSettings(sessionId: string, signal?: AbortSignal): Promise<SessionSettings> {
    return sessionSettingsSchema.parse(
      await this.assistantRequest(
        `/api/sessions/${encodeURIComponent(sessionId)}/settings`,
        'GET',
        undefined,
        AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
      ),
    );
  }

  /** Save once; a failed transport may have committed and must not be retried automatically. */
  async setSessionPolicy(sessionId: string, policy: string): Promise<void> {
    sessionPolicyUpdateResponseSchema.parse(
      await this.assistantRequest(
        `/api/sessions/${encodeURIComponent(sessionId)}/policy`,
        'POST',
        sessionPolicyUpdateSchema.parse({ policy }),
        AbortSignal.timeout(15_000),
      ),
    );
  }

  /** Immediate child folders below the authenticated user's personal root. */
  async listPersonalFolders(path = ''): Promise<string[]> {
    const query = new URLSearchParams({ path });
    const res = await fetch(`${this.baseUrl}/api/workspaces/personal?${query}`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`listPersonalFolders failed: ${res.status}`);
    const body = personalFoldersResponseSchema.parse(await res.json());
    return body.folders;
  }

  async exportSession(sessionId: string): Promise<Blob> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/export`, {
      headers: this.authHeaders(),
    });
    if (!res.ok) throw new Error(`exportSession failed: ${res.status}`);
    return res.blob();
  }

  async deleteSession(sessionId: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}`, {
      method: 'DELETE',
      headers: this.authHeaders(),
    });
    if (res.status !== 204) throw new Error(`deleteSession failed: ${res.status}`);
    this.lastSeq.delete(sessionId);
  }

  /** Teams the current user belongs to (shared workspaces). */
  async listTeams(): Promise<TeamView[]> {
    const res = await fetch(`${this.baseUrl}/api/teams`, { headers: this.authHeaders() });
    if (!res.ok) {
      throw new Error(`listTeams failed: ${res.status}`);
    }
    const body = (await res.json()) as { teams: TeamView[] };
    return body.teams;
  }

  /** Creates a team; the caller becomes its owner. */
  async createTeam(name: string): Promise<{ teamId: string; name: string }> {
    const res = await fetch(`${this.baseUrl}/api/teams`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      throw new Error(`createTeam failed: ${res.status}`);
    }
    const body = (await res.json()) as { team: { id: string; name: string } };
    return { teamId: body.team.id, name: body.team.name };
  }

  /** Adds a tenant user (by email) to a team; owner/admin only. */
  async addTeamMember(teamId: string, email: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/api/teams/${teamId}/members`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({ email }),
    });
    if (!res.ok) {
      throw new Error(`addTeamMember failed: ${res.status}`);
    }
  }

  async shareBack(sessionId: string, eventId: string): Promise<void> {
    await this.assistantRequest(`/api/sessions/${sessionId}/share-back`, 'POST', { eventId });
  }

  async getTimeline(sessionId: string, beforeSeq?: number): Promise<TimelinePage> {
    return timelinePageSchema.parse(
      await this.assistantRequest(
        `/api/sessions/${sessionId}/timeline${beforeSeq ? `?beforeSeq=${beforeSeq}` : ''}`,
      ),
    );
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

  /** Fetch an attachment with the same bearer authentication as other API calls. */
  async fetchBlob(uri: string, signal?: AbortSignal): Promise<Blob> {
    const screenshot = /^blob:\/\/browser\/([^/]+)\/([A-Za-z0-9_-]{1,200})\.png$/.exec(uri);
    const url = screenshot
      ? `${this.baseUrl}/api/sessions/${encodeURIComponent(decodeURIComponent(screenshot[1]!))}/browser-images/${screenshot[2]}`
      : this.blobUrl(uri);
    const res = await fetch(url, {
      headers: this.authHeaders(),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) {
      throw new Error(`fetchBlob failed: ${res.status}`);
    }
    return res.blob();
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
    opts?: {
      /** Explicit start offset; overrides the remembered resume point. */ afterSeq?: number;
    },
  ): EventStreamHandle {
    if (opts?.afterSeq !== undefined) this.lastSeq.set(sessionId, opts.afterSeq);
    const startSeq = opts?.afterSeq ?? this.lastSeq.get(sessionId) ?? 0;
    let deliveredSeq = startSeq;
    let source: EventSourceLike | null = null;
    let closed = false;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const connect = (fromSeq: number): void => {
      const url = `${this.baseUrl}/api/sessions/${sessionId}/events?afterSeq=${fromSeq}${this.tokenQuery()}`;
      const next = this.eventSourceFactory(url);
      source = next;
      next.onmessage = (msg: { data: unknown; lastEventId?: string }) => {
        if (closed || source !== next) return;
        try {
          const parsed = serverEventSchema.parse(JSON.parse(String(msg.data)));
          attempts = 0; // healthy delivery resets the reconnect backoff
          // Native Last-Event-ID handling: seq ids arrive out-of-band.
          const seq = Number(msg.lastEventId);
          // EventSource inherits the previous id on Pub/Sub frames without id:.
          // Text/thought deltas are ephemeral and must never advance or dedupe
          // against the persisted log cursor.
          const liveDelta =
            parsed.type === 'session/update' &&
            (parsed.update.kind === 'agent_message_chunk' ||
              parsed.update.kind === 'agent_thought_chunk');
          if (!liveDelta && Number.isInteger(seq) && seq > 0) {
            if (seq <= deliveredSeq) return;
            deliveredSeq = seq;
            this.noteSeq(sessionId, seq);
            handlers.onSeq?.(seq);
          }
          handlers.onEvent(parsed);
        } catch (err) {
          handlers.onError?.(err);
        }
      };
      next.onerror = (err: unknown) => {
        if (closed || source !== next) return;
        handlers.onError?.(err);
        // Native EventSource retries transient network failures itself, but
        // permanently CLOSES after an HTTP error response (e.g. a proxy 500
        // while the server restarts). Detect that state and re-establish the
        // stream from the last committed seq with bounded backoff — otherwise
        // the pane goes silently stale until a manual refresh.
        if (closed || timer || next.readyState !== 2 /* CLOSED */) return;
        next.close();
        attempts += 1;
        const delayMs = Math.min(1000 * 2 ** (attempts - 1), 15_000);
        timer = setTimeout(() => {
          timer = null;
          if (!closed) connect(deliveredSeq);
        }, delayMs);
      };
    };
    connect(startSeq);
    return {
      close: () => {
        closed = true;
        if (timer) clearTimeout(timer);
        source?.close();
      },
    };
  }

  /** M3: answer a permission request (approval Modal in the web UI). */
  async respondApproval(
    sessionId: string,
    approvalId: string,
    outcome: 'allowed' | 'rejected',
    commandPrefix?: string[],
  ): Promise<void> {
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${sessionId}/approvals/${approvalId}/respond`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...this.authHeaders() },
        body: JSON.stringify({ outcome, commandPrefix }),
      },
    );
    if (!res.ok) {
      throw new Error(`respondApproval failed: ${res.status}`);
    }
  }

  /** M3: abort the in-flight turn of a session (session/cancel). */
  async cancelTurn(sessionId: string): Promise<TurnCancelResponse> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      throw new Error(`cancelTurn failed: ${res.status}`);
    }
    return turnCancelResponseSchema.parse(await res.json());
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
  /** EventSource readyState; 2 (CLOSED) means the native retry loop stopped. */
  readyState?: number;
  close(): void;
}
