import {
  workspaceDocumentSchema,
  workspaceDocumentRequestSchema,
  type WorkspaceDocumentRequest,
  type WorkspaceDocument,
} from '@trinity-harness/shared';
import { historyPreferencesSchema, type HistoryPreferences } from '@trinity-harness/shared';
import {
  personaSchema,
  personaHistorySchema,
  type PersonaHistory,
  type Persona,
  type PersonaChange,
} from '@trinity-harness/shared';
import {
  attachmentUploadResponseSchema,
  attachmentUploadErrorSchema,
  type AttachmentUploadResponse,
} from '@trinity-harness/shared';
import {
  speechPreferencesSchema,
  promptDeliverySchema,
  type PromptDelivery,
  type SpeechPreferences,
  newId,
  personalFoldersResponseSchema,
  workspacePathSchema,
  workspaceDirectorySchema,
  readFileResultSchema,
  type WorkspaceDirectory,
  type ReadFileResult,
  serverEventSchema,
  turnCancelResponseSchema,
  messageRevisionSchema,
  promptAcceptedSchema,
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
  MessageRevision,
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

/** Local connection metadata only; never includes URLs, credentials or event contents. */
export type EventStreamStatus =
  | { state: 'connecting' | 'open' }
  | {
      state: 'reconnecting';
      since: number;
      retryCount: number;
      disconnectedForMs: number;
      readyState: number | undefined;
      httpStatus?: number;
    }
  | { state: 'blocked'; reason: 'authentication' | 'access' | 'not_found' };

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

  private async readWorkspace(
    sessionId: string,
    kind: 'directory' | 'file',
    path: string,
    signal?: AbortSignal,
  ): Promise<unknown> {
    workspacePathSchema.parse(path);
    const response = await fetch(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/workspace/${kind}?${new URLSearchParams({ path })}`,
      {
        headers: this.authHeaders(),
        cache: 'no-store',
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]),
      },
    );
    if (!response.ok)
      throw new Error(`Workspace ${kind} unavailable (${response.status}). Refresh to try again.`);
    return response.json();
  }
  async listWorkspaceDirectory(
    sessionId: string,
    path = '',
    signal?: AbortSignal,
  ): Promise<WorkspaceDirectory> {
    return workspaceDirectorySchema.parse(
      await this.readWorkspace(sessionId, 'directory', path, signal),
    );
  }
  async workspaceDocument(
    sessionId: string,
    request: WorkspaceDocumentRequest,
    signal?: AbortSignal,
  ): Promise<WorkspaceDocument> {
    const response = await fetch(
      `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/workspace/document`,
      {
        method: 'POST',
        headers: { ...this.authHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify(workspaceDocumentRequestSchema.parse(request)),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120_000)]),
      },
    );
    if (!response.ok)
      throw new Error(
        'Document unavailable or changed. Reload before saving; your draft is retained.',
      );
    return workspaceDocumentSchema.parse(await response.json());
  }

  async readWorkspaceFile(
    sessionId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<ReadFileResult> {
    return readFileResultSchema.parse(await this.readWorkspace(sessionId, 'file', path, signal));
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
      headers: {
        ...this.authHeaders(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new Error(`Request failed (${res.status})`);
    if (res.status === 204) return undefined;
    return res.json();
  }
  async getHistoryPreferences(signal?: AbortSignal): Promise<HistoryPreferences | null> {
    const result = (await this.assistantRequest(
      '/api/me/history-preferences',
      'GET',
      undefined,
      AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
    )) as {
      preferences: unknown;
    };
    return result.preferences == null ? null : historyPreferencesSchema.parse(result.preferences);
  }
  async setHistoryPreferences(preferences: HistoryPreferences): Promise<HistoryPreferences> {
    return historyPreferencesSchema.parse(
      await this.assistantRequest(
        '/api/me/history-preferences',
        'PUT',
        historyPreferencesSchema.parse(preferences),
      ),
    );
  }
  async getSpeechPreferences(signal?: AbortSignal): Promise<SpeechPreferences> {
    return speechPreferencesSchema.parse(
      await this.assistantRequest(
        '/api/me/speech-preferences',
        'GET',
        undefined,
        AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
      ),
    );
  }
  async setSpeechPreferences(
    preferences: SpeechPreferences,
    signal?: AbortSignal,
  ): Promise<SpeechPreferences> {
    return speechPreferencesSchema.parse(
      await this.assistantRequest(
        '/api/me/speech-preferences',
        'PUT',
        speechPreferencesSchema.parse(preferences),
        AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
      ),
    );
  }
  async getPersonaHistory(before?: number): Promise<PersonaHistory> {
    return personaHistorySchema.parse(
      await this.assistantRequest(
        `/api/persona/history${before === undefined ? '' : `?before=${before}`}`,
      ),
    );
  }
  async savePersona(change: PersonaChange): Promise<Persona> {
    return personaSchema.parse(await this.assistantRequest('/api/persona', 'PUT', change));
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

  async getTimeline(
    sessionId: string,
    beforeSeq?: number,
    signal?: AbortSignal,
  ): Promise<TimelinePage> {
    return timelinePageSchema.parse(
      await this.assistantRequest(
        `/api/sessions/${sessionId}/timeline${beforeSeq ? `?beforeSeq=${beforeSeq}` : ''}`,
        'GET',
        undefined,
        signal,
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
    delivery?: PromptDelivery,
  ): Promise<string | undefined> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({
        text,
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        ...(delivery ? { delivery: promptDeliverySchema.parse(delivery) } : {}),
      }),
    });
    if (res.status !== 202) {
      throw new Error(`sendPrompt failed: ${res.status}`);
    }
    return promptAcceptedSchema.parse(await res.json()).promptId;
  }

  async removeMessage(
    sessionId: string,
    promptId: string,
    role: 'user' | 'assistant',
  ): Promise<void> {
    await this.assistantRequest(
      `/api/sessions/${sessionId}/messages/${promptId}/${role}`,
      'DELETE',
    );
  }

  async reviseMessage(
    sessionId: string,
    revision: MessageRevision,
    text: string,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.assistantRequest(
      `/api/sessions/${sessionId}/messages`,
      'POST',
      {
        text,
        revision: messageRevisionSchema.parse(revision),
      },
      signal,
    );
  }

  /** Subscribe before cancelling; only a durable terminal update confirms Stop. */
  async stopAndWait(sessionId: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const page = await this.getTimeline(sessionId, undefined, signal);
    let events = page.events;
    let before = page.nextBefore;
    while (
      before !== null &&
      !events.some((event) => event.type === 'message/committed' && event.message.role === 'user')
    ) {
      const older = await this.getTimeline(sessionId, before, signal);
      signal.throwIfAborted();
      if (older.nextBefore !== null && older.nextBefore >= before)
        throw new Error('History cursor did not advance');
      events = [...older.events, ...events];
      before = older.nextBefore;
    }
    let active = false;
    for (const event of events) {
      if (event.type === 'message/committed' && event.message.role === 'user') active = true;
      if (event.type === 'session/turn_status')
        active = event.status === 'running' || event.status === 'awaiting_approval';
      if (event.type === 'error') active = false;
    }
    signal.throwIfAborted();
    let stream: EventStreamHandle | undefined;
    let abort: (() => void) | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
        stream = this.openEventStream(
          sessionId,
          {
            onEvent: (event) => {
              if (
                event.type === 'error' ||
                (event.type === 'session/turn_status' &&
                  (event.status === 'aborted' || event.status === 'completed')) ||
                (!active && event.type === 'session/prompt_queue' && event.state === 'cancelled')
              )
                resolve();
            },
          },
          { afterSeq: page.lastSeq },
        );
        void this.cancelTurn(sessionId, signal).then((result) => {
          if (result.alreadyStopped) resolve();
        }, reject);
      });
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
      stream?.close();
    }
  }

  /**
   * M4 multimodal: upload an image/PDF/UTF-8 text attachment (raw octet-stream body).
   * Returns the `blob://` URI to reference from a subsequent prompt.
   */
  async uploadAttachment(
    sessionId: string,
    data: Blob,
    mimeType: string,
    filename?: string,
    operationId?: string,
    origin: 'file' | 'paste' = 'file',
  ): Promise<AttachmentUploadResponse> {
    const params = new URLSearchParams({ mime: mimeType });
    if (filename) params.set('filename', filename);
    if (operationId) params.set('operationId', operationId);
    params.set('origin', origin);
    const res = await fetch(
      `${this.baseUrl}/api/sessions/${sessionId}/attachments?${params.toString()}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream', ...this.authHeaders() },
        body: data,
      },
    );
    if (res.status !== 201) {
      const body: unknown = await res.json().catch(() => null);
      const failure = attachmentUploadErrorSchema.safeParse(body);
      throw new Error(
        failure.success ? failure.data.error : `uploadAttachment failed: ${res.status}`,
      );
    }
    return attachmentUploadResponseSchema.parse(await res.json());
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
      /** Transport lifecycle. Without this handler, transport errors use onError for compatibility. */
      onConnectionState?: (status: EventStreamStatus) => void;
      /** Event parsing/processing errors; also legacy transport errors without onConnectionState. */
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
    let disconnectedSince: number | null = null;
    let retryCount = 0;
    let diagnosed = false;
    let diagnostic: AbortController | null = null;
    let blocked = false;

    const reportReconnecting = (httpStatus?: number): void => {
      if (closed || blocked) return;
      disconnectedSince ??= Date.now();
      handlers.onConnectionState?.({
        state: 'reconnecting',
        since: disconnectedSince,
        retryCount,
        disconnectedForMs: Math.max(0, Date.now() - disconnectedSince),
        readyState: source?.readyState,
        ...(httpStatus !== undefined ? { httpStatus } : {}),
      });
    };

    const diagnose = async (): Promise<void> => {
      const controller = new AbortController();
      diagnostic = controller;
      try {
        // Native EventSource hides HTTP status. One bounded read per outage can
        // confirm auth/access failures without logging the token-bearing SSE URL.
        const res = await fetch(
          `${this.baseUrl}/api/sessions/${encodeURIComponent(sessionId)}/settings`,
          {
            headers: this.authHeaders(),
            cache: 'no-store',
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
          },
        );
        await res.body?.cancel();
        if (closed || controller.signal.aborted || diagnostic !== controller) return;
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          blocked = true;
          if (timer) clearTimeout(timer);
          timer = null;
          source?.close();
          handlers.onConnectionState?.({
            state: 'blocked',
            reason:
              res.status === 401 ? 'authentication' : res.status === 403 ? 'access' : 'not_found',
          });
        } else {
          reportReconnecting(res.status);
        }
      } catch {
        // An unavailable diagnostic cannot classify the outage; retain retries.
        if (!controller.signal.aborted && diagnostic === controller) reportReconnecting();
      } finally {
        if (diagnostic === controller) diagnostic = null;
      }
    };

    const connect = (fromSeq: number): void => {
      const url = `${this.baseUrl}/api/sessions/${sessionId}/events?afterSeq=${fromSeq}${this.tokenQuery()}`;
      const next = this.eventSourceFactory(url);
      source = next;
      next.onopen = () => {
        if (closed || blocked || source !== next) return;
        disconnectedSince = null;
        retryCount = 0;
        diagnosed = false;
        diagnostic?.abort();
        diagnostic = null;
        handlers.onConnectionState?.({ state: 'open' });
      };
      next.onmessage = (msg: { data: unknown; lastEventId?: string }) => {
        if (closed || blocked || source !== next) return;
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
        if (closed || blocked || source !== next) return;
        retryCount += 1;
        reportReconnecting();
        if (!handlers.onConnectionState) handlers.onError?.(err);
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
          if (!closed && !blocked) connect(deliveredSeq);
        }, delayMs);
        if (handlers.onConnectionState && retryCount >= 2 && !diagnosed) {
          diagnosed = true;
          void diagnose();
        }
      };
    };
    handlers.onConnectionState?.({ state: 'connecting' });
    connect(startSeq);
    return {
      close: () => {
        closed = true;
        diagnostic?.abort();
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
  async cancelTurn(sessionId: string, signal?: AbortSignal): Promise<TurnCancelResponse> {
    const res = await fetch(`${this.baseUrl}/api/sessions/${sessionId}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({}),
      ...(signal ? { signal } : {}),
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
  onopen?: (() => void) | null;
  onmessage: ((msg: { data: unknown; lastEventId?: string }) => void) | null;
  onerror: ((err: unknown) => void) | null;
  /** EventSource readyState; 2 (CLOSED) means the native retry loop stopped. */
  readyState?: number;
  close(): void;
}
