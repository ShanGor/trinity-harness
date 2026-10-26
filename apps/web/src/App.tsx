import { newId, pendingCreationSchema } from '@trinity-harness/shared';
import {
  AssistantMemory,
  AssistantHistory,
  AssistantTasks,
  MemoryContextDisclosure,
} from './personal-assistant';
import {
  createContext,
  useContext,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from 'react';

import type { ServerEvent, ModelUsage } from '@trinity-harness/shared';
import {
  App as AntdApp,
  Button,
  Collapse,
  Dropdown,
  Flex,
  Form,
  Image,
  Input,
  Layout,
  List,
  Modal,
  Select,
  Table,
  Tag,
  Typography,
  Upload,
} from 'antd';
import { Bubble } from '@ant-design/x';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import {
  AcpClient,
  type SessionSummary,
  type TeamView,
  type WorkspaceSelection,
} from '@trinity-harness/client-acp';

import { HistorySidebar, HistoryDivider } from './history-sidebar';
import { ChatComposer } from './chat-composer';
import './chat-layout.css';
import { ResponseActions } from './response-actions';
import { MessageTimestamp } from './message-timestamp';
import { AnswerCitationList } from './answer-citations';
import { UsagePanel } from './usage-panel';
import { TurnProgress } from './turn-progress';
import { BrowserActivity } from './browser-activity';
import { ScheduledTasks } from './scheduled-tasks';
import { InboxIndicator } from './inbox-indicator';
import { PersonalComputer } from './personal-computer';
import { loadTimelineWithPrompt } from './conversation-history';

import {
  applyTimelineEvent,
  mergeModelUsage,
  mergeRecallSelection,
  settleAssistantItems,
  setAssistantApproval,
  mergeAssistantChunk,
  mergeToolUpdate,
  mergeCommittedAssistantMessage,
  mergeCommittedUserMessage,
  newItemKey,
  type AttachmentView,
  type ChatItem,
} from './chat-items';

/**
 * M2 chat UI (docs/design.md §11.5): antd-x components consume the ACP-flavored
 * session/update events produced by the server — no private UI protocol. Auth:
 * bearer token from /api/auth/login, kept in sessionStorage; admin users get
 * an audit tab (docs/design.md §13). M6: session history sidebar, per-user /
 * per-team workspaces (docs/design.md §15), markdown rendering.
 */

const TOKEN_KEY = 'trinity.token';

type Role = 'admin' | 'developer' | 'viewer';
type MeUser = { id: string; email: string; role: Role };

type AuditRow = {
  id: string;
  at: string;
  userId: string;
  action: string;
  target?: string;
  result: string;
  sessionId?: string;
};

/** M3: an approval request waiting for the human (docs/design.md §12.2). */
type PendingApproval = {
  approvalId: string;
  toolName: string;
  title: string;
  argsPreview: string;
};

const client = new AcpClient({
  token: () => sessionStorage.getItem(TOKEN_KEY),
});

/** Workspace selector value encoding: 'personal' or `team:<id>`. */
function workspaceValue(ws: WorkspaceSelection): string {
  return ws.scope === 'team' ? `team:${ws.teamId}` : 'personal';
}

function workspaceLabel(s: SessionSummary, teams: TeamView[]): string {
  if (s.kind === 'chat') return 'Session workspace';
  if (s.scope !== 'team') {
    const marker = `/${s.userId}/`;
    const index = s.workspaceUri?.lastIndexOf(marker) ?? -1;
    return index < 0 ? 'personal' : `personal / ${s.workspaceUri?.slice(index + marker.length)}`;
  }
  return teams.find((t) => t.teamId === s.scopeId)?.name ?? 'team';
}

export default function App() {
  const { message, modal } = AntdApp.useApp();
  const [user, setUser] = useState<MeUser | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [historyCollapsed, setHistoryCollapsed] = useState(
    () => window.matchMedia('(max-width: 600px)').matches,
  );
  const [historyWidthRatio, setHistoryWidthRatio] = useState(0.18);
  const [mode, setMode] = useState<'chat' | 'work'>('chat');
  const [page, setPage] = useState<
    'conversation' | 'tasks' | 'history' | 'memory' | 'scheduled' | 'computer' | 'audit'
  >('conversation');
  const activityBySession = useRef(
    new Map<string, { sourceSessionId: string; sourceEventId: string; kind: 'chat' | 'work' }[]>(),
  );
  const [activities, setActivities] = useState<
    { sourceSessionId: string; sourceEventId: string; kind: 'chat' | 'work' }[]
  >([]);
  const [queuedPrompts, setQueuedPrompts] = useState<{ promptId: string; text: string }[]>([]);
  const composerDrafts = useRef(new Map<string, string>());
  const timelineHistory = useRef(
    new Map<string, { events: ServerEvent[]; before: number | null }>(),
  );
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [olderBefore, setOlderBefore] = useState<number | null>(null);
  const [mainSessionId, setMainSessionId] = useState<string | null>(null);
  const [creationPending, setCreationPending] = useState(false);
  const creationOperation = useRef<string>(newId());
  const creationPromise = useRef<Promise<string> | null>(null);
  const [draftOrigin, setDraftOrigin] = useState<string | null>(null);
  const [workspaceChosen, setWorkspaceChosen] = useState(false);
  const localFiles = useRef(new Map<string, File>());
  const conversationCache = useRef(
    new Map<
      string,
      {
        items: ChatItem[];
        usage: ModelUsage[];
        busy: boolean;
        approval: PendingApproval | null;
        staged: (AttachmentView & { name: string })[];
      }
    >(),
  );
  const currentView = useRef({
    items: [] as ChatItem[],
    usage: [] as ModelUsage[],
    busy: false,
    approval: null as PendingApproval | null,
    staged: [] as (AttachmentView & { name: string })[],
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [items, setItems] = useState<ChatItem[]>([]);
  const [usageRecords, setUsageRecords] = useState<ModelUsage[]>([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [teams, setTeams] = useState<TeamView[]>([]);
  /** Workspace for the NEXT session (existing sessions keep their own). */
  const [workspace, setWorkspace] = useState<WorkspaceSelection>({ scope: 'personal' });
  const [busy, setBusy] = useState(false);
  const draftResetVersion = 0;
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [policy, setPolicy] = useState<string>('workspace-write');
  const [teamsOpen, setTeamsOpen] = useState(false);
  const [folderPickerOpen, setFolderPickerOpen] = useState(false);
  const [browsePath, setBrowsePath] = useState('');
  const [folders, setFolders] = useState<string[]>([]);
  const [foldersLoading, setFoldersLoading] = useState(false);
  /** M4: attachments staged for the next prompt (uploaded on selection). */
  const [staged, setStaged] = useState<(AttachmentView & { name: string })[]>([]);
  currentView.current = { items, usage: usageRecords, busy, approval, staged };
  const sessionRef = useRef<string | null>(null);
  const streamRef = useRef<{ close(): void } | null>(null);

  useEffect(() => {
    if (!folderPickerOpen) return;
    let active = true;
    setFoldersLoading(true);
    void client
      .listPersonalFolders(browsePath)
      .then(
        (names) => {
          if (active) setFolders(names);
        },
        (error: unknown) => {
          if (active) {
            setFolders([]);
            message.error(error instanceof Error ? error.message : String(error));
          }
        },
      )
      .finally(() => {
        if (active) setFoldersLoading(false);
      });
    return () => {
      active = false;
    };
  }, [browsePath, folderPickerOpen, message]);

  const refreshSessions = useCallback(async () => {
    try {
      setSessions(await client.listSessions());
    } catch {
      // Sidebar refresh is best-effort; the chat itself does not depend on it.
    }
  }, []);

  const refreshTeams = useCallback(async () => {
    try {
      setTeams(await client.listTeams());
    } catch {
      // Team workspaces are optional (endpoint exists when the store does).
    }
  }, []);

  const handleEvent = useCallback(
    (event: ServerEvent, replay = false) => {
      const history = sessionRef.current
        ? timelineHistory.current.get(sessionRef.current)
        : undefined;
      history?.events.push(event);
      if (event.type === 'session/activity') {
        const id = sessionRef.current;
        if (id) {
          const current = activityBySession.current.get(id) ?? [];
          const next = current.some(
            (entry) =>
              entry.sourceSessionId === event.sourceSessionId &&
              entry.sourceEventId === event.sourceEventId,
          )
            ? current
            : [...current, event];
          activityBySession.current.set(id, next);
          setActivities(next);
        }
        return;
      }
      if (event.type === 'session/memory_selection') {
        setItems((prev) => mergeRecallSelection(prev, event.receipt));
        return;
      }
      if (event.type === 'session/prompt_queue') {
        if (event.state === 'queued')
          setQueuedPrompts((prev) =>
            prev.some((entry) => entry.promptId === event.promptId)
              ? prev
              : [...prev, { promptId: event.promptId, text: event.text ?? 'Queued request' }],
          );
        else setQueuedPrompts((prev) => prev.filter((entry) => entry.promptId !== event.promptId));
        return;
      }
      if (event.type === 'model/usage') {
        setUsageRecords((records) =>
          records.some((entry) => entry.requestId === event.usage.requestId)
            ? records
            : [...records, event.usage],
        );
        setItems((items) => mergeModelUsage(items, event.usage, newItemKey));
        return;
      }
      if (event.type === 'error') {
        if (!replay) message.error(event.message);
        setBusy(false);
        setApproval(null);
        setItems((items) => settleAssistantItems(items, 'error', event.message));
        return;
      }
      if (event.type === 'message/committed') {
        if (event.message.role === 'assistant') {
          // Live: fill the optimistic placeholder. Replay: append a new item
          // (see chat-items.ts — the placeholder only exists in the live flow).
          setItems((prev) =>
            mergeCommittedAssistantMessage(
              prev,
              event.message.content,
              newItemKey,
              event.message.at,
              event.message,
            ),
          );
        } else {
          if (event.message.id)
            setQueuedPrompts((prev) => prev.filter((entry) => entry.promptId !== event.message.id));
          // Replayed/relayed user message — skip if we already rendered it
          // locally when the prompt was sent (see chat-items.ts for why the
          // match targets the most recent USER item, not the last item).
          setItems((prev) =>
            mergeCommittedUserMessage(
              prev,
              {
                content: event.message.content,
                id: event.message.id,
                at: event.message.at,
                attachments: event.message.attachments,
              },
              newItemKey,
            ),
          );
        }
        return;
      }
      if (event.type === 'session/update' && event.update.kind === 'agent_message_chunk') {
        const { text } = event.update;
        setItems((prev) =>
          mergeAssistantChunk(prev, text, newItemKey, new Date(Date.now()).toISOString()),
        );
        setBusy(true);
        return;
      }
      if (event.type === 'session/update' && event.update.kind === 'tool_call') {
        const update = event.update;
        setItems((items) =>
          mergeToolUpdate(items, update, newItemKey, new Date(Date.now()).toISOString()),
        );
        return;
      }
      if (event.type === 'session/update' && event.update.kind === 'permission_request') {
        // M3 approval flow (docs/design.md §12.2): surface the gate, wait
        // for the human; the Modal answers via respondApproval.
        const awaitingApproval = event.update.status === 'pending';
        setItems((items) => setAssistantApproval(items, awaitingApproval));
        if (awaitingApproval) {
          setApproval({
            approvalId: event.update.approvalId,
            toolName: event.update.toolName,
            title: event.update.title,
            argsPreview: event.update.argsPreview,
          });
        } else {
          setApproval(null);
        }
        return;
      }
      if (event.type === 'session/turn_status') {
        if (event.status === 'running' || event.status === 'awaiting_approval') {
          const awaitingApproval = event.status === 'awaiting_approval';
          setItems((items) => setAssistantApproval(items, awaitingApproval));
        }
        if (event.status === 'completed' || event.status === 'aborted') {
          const status = event.status;
          setBusy(false);
          setApproval(null);
          setItems((items) => settleAssistantItems(items, status));
        }
      }
    },
    [message],
  );

  const openStream = useCallback(
    (id: string, fromSeq?: number) => {
      streamRef.current?.close();
      streamRef.current = client.openEventStream(
        id,
        {
          onEvent: (event) => {
            if (sessionRef.current === id) handleEvent(event);
          },
          onError: (err) => message.warning(`event stream error (reconnecting): ${String(err)}`),
        },
        fromSeq !== undefined ? { afterSeq: fromSeq } : undefined,
      );
    },
    [handleEvent, message],
  );

  const onApprove = useCallback(
    async (outcome: 'allowed' | 'rejected', commandPrefix?: string[]) => {
      if (!approval || !sessionRef.current) return;
      try {
        await client.respondApproval(
          sessionRef.current,
          approval.approvalId,
          outcome,
          commandPrefix,
        );
        setApproval(null);
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [approval, message],
  );

  const onCancelTurn = useCallback(async () => {
    if (!sessionRef.current) return;
    try {
      const sessionId = sessionRef.current;
      const result = await client.cancelTurn(sessionId);
      if (sessionRef.current !== sessionId) return;
      setApproval(null);
      if (result.alreadyStopped) {
        setBusy(false);
        setItems((items) => settleAssistantItems(items, 'aborted'));
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  }, [message]);

  useEffect(() => {
    return () => streamRef.current?.close();
  }, []);

  // On load: a stored token may still be valid — ask /api/me.
  useEffect(() => {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (!token) {
      setAuthChecked(true);
      return;
    }
    fetch('/api/me', { headers: { authorization: `Bearer ${token}` } })
      .then(async (res) => {
        if (res.ok) {
          const body = (await res.json()) as { user: MeUser };
          setUser(body.user);
          await Promise.all([refreshSessions(), refreshTeams()]);
        } else {
          sessionStorage.removeItem(TOKEN_KEY);
        }
      })
      .catch(() => sessionStorage.removeItem(TOKEN_KEY))
      .finally(() => setAuthChecked(true));
  }, [refreshSessions, refreshTeams]);

  const onLogin = useCallback(
    async (values: { email: string; password: string }) => {
      try {
        const { token, user: loggedIn } = (await client.login(values.email, values.password)) as {
          token: string;
          user: MeUser;
        };
        sessionStorage.setItem(TOKEN_KEY, token);
        setUser(loggedIn);
        await Promise.all([refreshSessions(), refreshTeams()]);
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [message, refreshSessions, refreshTeams],
  );

  const logout = useCallback(() => {
    sessionStorage.removeItem(TOKEN_KEY);
    activityBySession.current.clear();
    setActivities([]);
    composerDrafts.current.clear();
    conversationCache.current.clear();
    timelineHistory.current.clear();
    setMainSessionId(null);
    streamRef.current?.close();
    setUser(null);
    setItems([]);
    setUsageRecords([]);
    setSessions([]);
    setTeams([]);
    setSessionId(null);
    sessionRef.current = null;
  }, []);

  /** Opens the event stream and marks the session active. */
  const activateSession = useCallback(
    (id: string, fromSeq?: number) => {
      sessionRef.current = id;
      setSessionId(id);
      openStream(id, fromSeq);
    },
    [openStream],
  );

  const saveCurrentView = useCallback(() => {
    conversationCache.current.set(sessionRef.current ?? 'new', currentView.current);
  }, []);

  const ensureSession = useCallback(
    async (title?: string): Promise<string> => {
      if (sessionRef.current) return sessionRef.current;
      if (creationPromise.current) return creationPromise.current;
      setCreationPending(true);
      if (user)
        sessionStorage.setItem(
          `trinity.pendingCreation:${user.id}`,
          JSON.stringify({
            operationId: creationOperation.current,
            kind: mode,
            policy: mode === 'chat' ? 'workspace-write' : policy,
            ...(mode === 'work' ? { workspace } : {}),
            ...(title ? { title } : {}),
          }),
        );
      const pending = client.createSession(
        title,
        mode === 'chat' ? 'workspace-write' : policy,
        mode === 'work' ? workspace : undefined,
        {
          kind: mode,
          creationOperationId: creationOperation.current,
          ...((draftOrigin ?? mainSessionId)
            ? { originSessionId: (draftOrigin ?? mainSessionId)! }
            : {}),
        },
      );
      creationPromise.current = pending;
      try {
        const id = await pending;
        if (user) sessionStorage.removeItem(`trinity.pendingCreation:${user.id}`);
        activateSession(id);
        setCreationPending(false);
        await refreshSessions();
        return id;
      } catch (error) {
        const status = (error as { status?: number }).status;
        if (status && status >= 400 && status < 500) {
          setCreationPending(false);
          if (user) sessionStorage.removeItem(`trinity.pendingCreation:${user.id}`);
          creationOperation.current = newId();
        }
        throw error;
      } finally {
        creationPromise.current = null;
      }
    },
    [activateSession, mainSessionId, mode, policy, refreshSessions, workspace, user, draftOrigin],
  );

  const switchSession = useCallback(
    (id: string) => {
      setPage('conversation');
      void refreshSessions();
      if (id === sessionRef.current) return;
      saveCurrentView();
      setOlderBefore(timelineHistory.current.get(id)?.before ?? null);
      setLoadingOlder(false);
      const cached = conversationCache.current.get(id);
      setActivities(activityBySession.current.get(id) ?? []);
      setItems(cached?.items ?? []);
      setUsageRecords(cached?.usage ?? []);
      setQueuedPrompts([]);
      setApproval(cached?.approval ?? null);
      setStaged(cached?.staged ?? []);
      setBusy(cached?.busy ?? false);
      if (cached) {
        activateSession(id);
        return;
      }
      streamRef.current?.close();
      sessionRef.current = id;
      setSessionId(id);
      void loadTimelineWithPrompt(client, id, undefined, () => sessionRef.current !== id)
        .then((timeline) => {
          if (sessionRef.current !== id) return;
          timelineHistory.current.set(id, { events: [], before: timeline.nextBefore });
          for (const event of timeline.events) handleEvent(event, true);
          setOlderBefore(timeline.nextBefore);
          activateSession(id, timeline.lastSeq);
        })
        .catch((error: unknown) => {
          if (sessionRef.current === id) message.error(String(error));
        });
    },
    [activateSession, saveCurrentView, refreshSessions, handleEvent, message],
  );

  const newChat = useCallback(() => {
    saveCurrentView();
    setPage('conversation');
    setOlderBefore(null);
    streamRef.current?.close();
    const cached = conversationCache.current.get('new');
    setItems([]);
    setUsageRecords([]);
    setApproval(null);
    setStaged(cached?.staged ?? []);
    setBusy(false);
    sessionRef.current = null;
    setSessionId(null);
    setMode('chat');
    setDraftOrigin(null);
    setWorkspaceChosen(false);
    setCreationPending(false);
    creationOperation.current = newId();
  }, [saveCurrentView]);

  useEffect(() => {
    if (!user) return;
    let active = true;
    void client
      .ensureMainChat()
      .then(async (id) => {
        if (!active) return;
        setMainSessionId(id);
        let recovered: string | undefined;
        const raw = sessionStorage.getItem(`trinity.pendingCreation:${user.id}`);
        if (raw) {
          let value: unknown;
          try {
            value = JSON.parse(raw);
          } catch {
            value = null;
          }
          const saved = pendingCreationSchema.safeParse(value);
          if (saved.success) {
            setCreationPending(true);
            creationOperation.current = saved.data.operationId;
            setMode(saved.data.kind);
            setPolicy(saved.data.policy);
            if (saved.data.workspace) {
              setWorkspace(saved.data.workspace);
              setWorkspaceChosen(true);
            }
            recovered = await client.createSession(
              saved.data.title,
              saved.data.policy,
              saved.data.workspace,
              { kind: saved.data.kind, creationOperationId: saved.data.operationId },
            );
            sessionStorage.removeItem(`trinity.pendingCreation:${user.id}`);
            const draft = sessionStorage.getItem(`trinity.draft:${user.id}:new`);
            if (draft) {
              composerDrafts.current.set(recovered, draft);
              sessionStorage.setItem(`trinity.draft:${user.id}:${recovered}`, draft);
            }
            setCreationPending(false);
          } else sessionStorage.removeItem(`trinity.pendingCreation:${user.id}`);
        }
        await refreshSessions();
        if (active && !sessionRef.current) switchSession(recovered ?? id);
      })
      .catch((error: unknown) =>
        message.error(error instanceof Error ? error.message : String(error)),
      );
    return () => {
      active = false;
    };
  }, [user, message, refreshSessions, switchSession]);

  const exportSession = useCallback(
    async (id: string) => {
      try {
        const blob = await client.exportSession(id);
        const url = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.download = `session-${id}.json`;
        document.body.append(link);
        link.click();
        link.remove();
        requestAnimationFrame(() => URL.revokeObjectURL(url));
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      }
    },
    [message],
  );

  const confirmDeleteSession = useCallback(
    (id: string) => {
      modal.confirm({
        title: 'Delete this session from history?',
        content: 'The session will close and can no longer be opened.',
        okText: 'Delete',
        okButtonProps: { danger: true },
        async onOk() {
          try {
            await client.deleteSession(id);
            if (sessionRef.current === id) newChat();
            await refreshSessions();
          } catch (err) {
            message.error(err instanceof Error ? err.message : String(err));
            throw err;
          }
        },
      });
    },
    [message, modal, newChat, refreshSessions],
  );

  /** Stage locally; first submit commits the immutable session identity. */
  const onStageFile = useCallback(
    async (file: File) => {
      if (
        file.size > 20 * 1024 * 1024 ||
        !['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'application/pdf'].includes(
          file.type,
        )
      ) {
        message.error('Choose an image or PDF up to 20 MB.');
        return;
      }
      const uri = URL.createObjectURL(file);
      localFiles.current.set(uri, file);
      setStaged((prev) => [
        ...prev,
        {
          kind: file.type === 'application/pdf' ? 'file' : 'image',
          uri,
          mimeType: file.type,
          name: file.name,
        },
      ]);
    },
    [message],
  );

  const onSubmit = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if ((!trimmed && staged.length === 0) || (busy && sessionRef.current !== mainSessionId))
        return false;
      if (sessionRef.current === mainSessionId && mainSessionId) {
        try {
          const attachments = [];
          for (const attachment of staged) {
            const file = localFiles.current.get(attachment.uri);
            const uploaded = file
              ? await client.uploadAttachment(mainSessionId, file, file.type, file.name)
              : attachment;
            attachments.push({
              uri: uploaded.uri,
              mimeType: uploaded.mimeType ?? 'application/octet-stream',
            });
          }
          await client.sendPrompt(mainSessionId, trimmed || '[see attachments]', attachments);
          setStaged([]);
          return true;
        } catch (error) {
          message.error(error instanceof Error ? error.message : String(error));
          return false;
        }
      }
      if (trimmed.length === 0 && staged.length === 0) return;
      const sent = staged.map(({ kind, uri, mimeType }) => ({ kind, uri, mimeType }));
      const mimeList = staged.map(({ uri, mimeType }) => ({
        uri,
        mimeType: mimeType ?? 'application/octet-stream',
      }));
      setStaged([]);
      setBusy(true);
      setItems((prev) => [
        ...prev,
        {
          key: newItemKey(),
          role: 'user',
          at: new Date(Date.now()).toISOString(),
          content: trimmed || '[attachments]',
          streaming: false,
          tools: [],
          attachments: sent,
        },
        {
          key: newItemKey(),
          role: 'assistant',
          at: new Date(Date.now()).toISOString(),
          content: '',
          streaming: true,
          tools: [],
          attachments: [],
        },
      ]);
      try {
        // First prompt of a session doubles as its sidebar title.
        const id = await ensureSession(trimmed.slice(0, 60) || undefined);
        for (const attachment of mimeList) {
          const file = localFiles.current.get(attachment.uri);
          if (file) {
            const uploaded = await client.uploadAttachment(id, file, file.type, file.name);
            attachment.uri = uploaded.uri;
          }
        }
        await client.sendPrompt(id, trimmed || '[see attachments]', mimeList);
        for (const attachment of staged) {
          if (localFiles.current.has(attachment.uri)) {
            URL.revokeObjectURL(attachment.uri);
            localFiles.current.delete(attachment.uri);
          }
        }
        await refreshSessions();
        return true;
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
        setBusy(false);
        setItems((items) => settleAssistantItems(items, 'error'));
        setStaged(staged);
        return false;
      }
    },
    [mainSessionId, mode, workspaceChosen, busy, ensureSession, message, refreshSessions, staged],
  );

  const unrecordedTurns = useMemo(() => {
    const recorded = new Set(usageRecords.map((record) => record.promptId));
    return items.filter(
      (item) => item.role === 'user' && (!item.messageId || !recorded.has(item.messageId)),
    ).length;
  }, [items, usageRecords]);
  const loadOlder = useCallback(async (): Promise<void> => {
    const id = sessionRef.current;
    const history = id ? timelineHistory.current.get(id) : undefined;
    if (!id || !history || history.before === null || loadingOlder) return;
    setLoadingOlder(true);
    try {
      const page = await loadTimelineWithPrompt(
        client,
        id,
        history.before,
        () => sessionRef.current !== id,
      );
      if (sessionRef.current !== id) return;
      history.events = [...page.events, ...history.events];
      history.before = page.nextBefore;
      setItems(history.events.reduce(applyTimelineEvent, [] as ChatItem[]));
      setUsageRecords((current) => {
        const records = page.events.flatMap((event) =>
          event.type === 'model/usage' ? [event.usage] : [],
        );
        return [
          ...records.filter(
            (record) => !current.some((entry) => entry.requestId === record.requestId),
          ),
          ...current,
        ];
      });
      setOlderBefore(page.nextBefore);
    } catch (error) {
      if (sessionRef.current === id) message.error(String(error));
    } finally {
      if (sessionRef.current === id) setLoadingOlder(false);
    }
  }, [loadingOlder, message]);
  const recentSessions = useMemo(
    () => sessions.filter((session) => session.sessionRole !== 'main').slice(0, 12),
    [sessions],
  );
  const linkedActiveIds = useMemo(
    () =>
      sessions
        .filter(
          (entry) =>
            entry.originSessionId === mainSessionId &&
            entry.kind === 'work' &&
            ['queued', 'running', 'needs_approval'].includes(entry.taskState ?? ''),
        )
        .slice(0, 12)
        .map((entry) => entry.sessionId)
        .join(','),
    [sessions, mainSessionId],
  );
  useEffect(() => {
    const handles = linkedActiveIds
      .split(',')
      .filter(Boolean)
      .map((id) =>
        client.openEventStream(id, {
          onEvent: (event) => {
            if (
              event.type === 'session/turn_status' ||
              (event.type === 'session/update' && event.update.kind === 'permission_request')
            )
              void refreshSessions();
          },
        }),
      );
    return () => {
      for (const handle of handles) handle.close();
    };
  }, [linkedActiveIds, refreshSessions]);
  const activeSession = sessions.find((s) => s.sessionId === sessionId);
  const activeTitle = activeSession?.title;
  const isMain = !!sessionId && sessionId === mainSessionId;
  const effectiveMode = activeSession?.kind ?? mode;

  const chatPanel = (
    <div className="chat-panel" hidden={page !== 'conversation'}>
      {items.length === 0 && (
        <div className="empty-chat-state">
          <img src="/branding/trinity-logo.png" alt="Trinity logo" />
          <span className="eyebrow">
            {effectiveMode === 'chat' ? 'A LITTLE CLARITY, A NEW IDEA' : 'FROM IDEA TO DONE'}
          </span>
          <Typography.Title level={2}>
            {effectiveMode === 'chat'
              ? 'Where should we begin?'
              : 'What would you like to work on?'}
          </Typography.Title>
          <Typography.Text className="empty-chat-description">
            {effectiveMode === 'chat'
              ? 'Ask a question, explore an idea, or talk something through.'
              : 'Research a topic, build something, or tackle a task in your workspace.'}
          </Typography.Text>
          <div className="empty-chat-capabilities" aria-label="Things you can work on">
            {(effectiveMode === 'chat'
              ? ['Explore an idea', 'Understand a topic', 'Find the right words']
              : ['Research & synthesize', 'Build & refine', 'Review & improve']
            ).map((label) => (
              <span key={label}>{label}</span>
            ))}
          </div>
        </div>
      )}
      {olderBefore !== null && (
        <Button loading={loadingOlder} onClick={() => void loadOlder()}>
          Load older messages
        </Button>
      )}
      {items.length > 0 && <ChatTranscript items={items} sessionId={sessionId} />}
      {isMain && activities.length > 0 && (
        <div className="linked-work-cards" aria-label="Shared answers">
          {activities.slice(-8).map((entry) => (
            <Button
              key={`${entry.sourceSessionId}-${entry.sourceEventId}`}
              onClick={() => switchSession(entry.sourceSessionId)}
            >
              {entry.kind === 'work' ? 'Shared Work result' : 'Shared Chat answer'} ↗
            </Button>
          ))}
        </div>
      )}
      {isMain &&
        sessions.some((entry) => entry.kind === 'work' && entry.originSessionId === sessionId) && (
          <div className="linked-work-cards" aria-label="Linked work">
            {sessions
              .filter((entry) => entry.kind === 'work' && entry.originSessionId === sessionId)
              .slice(0, 6)
              .map((entry) => (
                <Button key={entry.sessionId} onClick={() => switchSession(entry.sessionId)}>
                  {entry.scope === 'team' ? 'Team task' : entry.title || 'Work'} ·{' '}
                  {entry.taskState?.replaceAll('_', ' ') ?? 'draft'}
                </Button>
              ))}
          </div>
        )}

      {!sessionId && draftOrigin && (
        <Typography.Paragraph className="related-work-source">
          Related conversation linked. Review the brief and select a workspace before Start.
        </Typography.Paragraph>
      )}
      {!sessionId && mode === 'work' && (
        <div className="work-setup">
          <Typography.Text strong>Workspace</Typography.Text>
          <Select
            aria-label="Work workspace"
            placeholder="Choose personal or team space"
            disabled={creationPending}
            value={workspaceChosen ? workspaceValue(workspace) : undefined}
            options={[
              { value: 'personal', label: 'Personal workspace' },
              ...teams.map((team) => ({
                value: `team:${team.teamId}`,
                label: `${team.name} · shared with team`,
              })),
            ]}
            onChange={(value) => {
              setWorkspaceChosen(true);
              setWorkspace(
                value === 'personal'
                  ? { scope: 'personal' }
                  : { scope: 'team', teamId: value.slice(5) },
              );
            }}
          />
          {workspaceChosen && workspace.scope === 'personal' && (
            <Button
              disabled={creationPending}
              onClick={() => {
                setBrowsePath(workspace.path ?? '');
                setFolderPickerOpen(true);
              }}
            >
              {workspace.path || 'Personal root · choose folder'}
            </Button>
          )}
          <Select
            aria-label="Work permissions"
            value={policy}
            disabled={creationPending}
            onChange={setPolicy}
            options={[
              { value: 'workspace-write', label: 'Workspace write · ask' },
              { value: 'read-only', label: 'Read only' },
            ]}
          />
        </div>
      )}
      {creationPending && !sessionId && (
        <div role="status">
          Resolving conversation creation…{' '}
          <Button
            onClick={() =>
              void ensureSession().catch((error: unknown) => message.error(String(error)))
            }
          >
            Retry connection
          </Button>
        </div>
      )}
      {isMain && queuedPrompts.length > 0 && (
        <div className="queued-prompts" role="status">
          <Typography.Text strong>Queued · {queuedPrompts.length}</Typography.Text>
          {queuedPrompts.map((entry) => (
            <Typography.Paragraph key={entry.promptId} ellipsis>
              {entry.text}
            </Typography.Paragraph>
          ))}
        </div>
      )}
      <div className="composer-dock">
        <div className="composer-card">
          {staged.length > 0 && (
            <div className="composer-attachments" role="group" aria-label="Attached files">
              {staged.map((att) =>
                att.kind === 'image' ? (
                  <div className="staged-image-card" key={att.uri}>
                    <AttachmentItem attachment={att} size={48} />
                    <Typography.Text ellipsis title={att.name} className="staged-image-name">
                      {att.name}
                    </Typography.Text>
                    <Button
                      className="staged-image-remove"
                      type="text"
                      shape="circle"
                      size="small"
                      aria-label={`Remove ${att.name}`}
                      onClick={() => setStaged((prev) => prev.filter((s) => s.uri !== att.uri))}
                    >
                      ×
                    </Button>
                  </div>
                ) : (
                  <Tag
                    className="staged-file-tag"
                    key={att.uri}
                    closable
                    onClose={() => setStaged((prev) => prev.filter((s) => s.uri !== att.uri))}
                  >
                    📄 {att.name}
                  </Tag>
                ),
              )}
            </div>
          )}
          <Flex gap={8} align="center" className="chat-composer">
            <Upload
              beforeUpload={(file) => {
                void onStageFile(file as unknown as File);
                return false; // keep antd from posting the file itself
              }}
              showUploadList={false}
              accept="image/png,image/jpeg,image/webp,image/gif,application/pdf"
              disabled={busy && !isMain}
            >
              <Button
                icon={<span>＋</span>}
                disabled={busy && !isMain}
                aria-label="Attach image or PDF"
              />
            </Upload>
            <div className="chat-composer-input">
              <ChatComposer
                draftOwner={user?.id}
                draftStore={composerDrafts.current}
                draftKey={sessionId ?? 'new'}
                canQueue={isMain}
                busy={busy}
                placeholder={mode === 'chat' ? 'Ask anything…' : 'Describe a task…'}
                resetVersion={draftResetVersion}
                onSubmit={onSubmit}
                onCancel={onCancelTurn}
              />
            </div>
          </Flex>
        </div>
        <p className="composer-hint">Enter to send · Shift + Enter for a new line</p>
      </div>
    </div>
  );

  const auditPanel = user?.role === 'admin' ? <AuditTable /> : null;

  if (!authChecked) {
    return null;
  }

  if (!user) {
    return (
      <div className="login-screen">
        <Form className="login-card" layout="vertical" onFinish={onLogin}>
          <img className="login-logo" src="/branding/trinity-logo.png" alt="Trinity logo" />
          <span className="eyebrow">AI WORKSPACE</span>
          <Typography.Title level={2}>Welcome to Trinity</Typography.Title>
          <Typography.Paragraph type="secondary">Sign in to your workspace</Typography.Paragraph>
          <Form.Item name="email" label="Email" rules={[{ required: true, type: 'email' }]}>
            <Input autoComplete="username" />
          </Form.Item>
          <Form.Item name="password" label="Password" rules={[{ required: true }]}>
            <Input.Password autoComplete="current-password" />
          </Form.Item>
          <Button type="primary" htmlType="submit" block>
            Sign in
          </Button>
        </Form>
      </div>
    );
  }

  return (
    <Layout className="trinity-shell">
      <HistorySidebar collapsed={historyCollapsed} widthRatio={historyWidthRatio}>
        <div className="sider-brand">
          <img src="/branding/trinity-logo.png" alt="Trinity logo" />
          <div>
            <strong>Trinity</strong>
            <span>AI Workspace</span>
          </div>
        </div>
        <nav className="sidebar-navigation" aria-label="Workspace navigation">
          <Button
            className="new-chat-button"
            type="text"
            disabled={creationPending}
            onClick={newChat}
          >
            <span aria-hidden="true">＋</span> New
          </Button>
          <Button
            type="text"
            onClick={() => mainSessionId && switchSession(mainSessionId)}
            aria-current={isMain && page === 'conversation' ? 'page' : undefined}
          >
            Main chat
          </Button>
          <Button
            type="text"
            onClick={() => {
              void refreshSessions();
              setPage('tasks');
            }}
            aria-current={page === 'tasks' ? 'page' : undefined}
          >
            Tasks{' '}
            {sessions.filter(
              (entry) =>
                entry.kind === 'work' &&
                ['queued', 'running', 'needs_approval'].includes(entry.taskState ?? ''),
            ).length || ''}
          </Button>
          <Button
            type="text"
            onClick={() => setPage('history')}
            aria-current={page === 'history' ? 'page' : undefined}
          >
            History
          </Button>
          <Button
            type="text"
            aria-current={page === 'scheduled' ? 'page' : undefined}
            onClick={() => setPage('scheduled')}
          >
            <span aria-hidden="true">◷</span> Scheduled
          </Button>
          <InboxIndicator client={client} onOpen={() => setPage('scheduled')} />
          <Button
            type="text"
            aria-current={page === 'computer' ? 'page' : undefined}
            onClick={() => {
              void refreshSessions();
              setPage('computer');
            }}
          >
            Browser / VM
          </Button>
        </nav>
        <span className="sider-section-label">Recent</span>
        <div className="history-scroll">
          <RecentConversations
            sessions={recentSessions}
            sessionId={sessionId}
            user={user}
            teams={teams}
            onSelect={switchSession}
            onExport={exportSession}
            onDelete={confirmDeleteSession}
          />
        </div>
        <div className="sidebar-account">
          <Dropdown
            menu={{
              items: [
                { key: 'teams', label: 'Teams' },
                { key: 'memory', label: 'Memory' },
                ...(user.role === 'admin' ? [{ key: 'audit', label: 'Audit log' }] : []),
                { key: 'sign-out', label: 'Sign out', danger: true },
              ],
              onClick: ({ key }) => {
                if (key === 'memory') setPage('memory');
                if (key === 'audit') setPage('audit');
                if (key === 'teams') setTeamsOpen(true);
                if (key === 'sign-out') logout();
              },
            }}
            placement="topLeft"
            trigger={['click']}
          >
            <Button
              size="small"
              type="text"
              className="account-menu-trigger"
              aria-label={`Account menu for ${user.email}`}
              title={`${user.email} (${user.role})`}
            >
              <span className="account-menu-label">{user.email}</span>
              <span aria-hidden="true">⌄</span>
            </Button>
          </Dropdown>
        </div>
      </HistorySidebar>
      <HistoryDivider
        collapsed={historyCollapsed}
        widthRatio={historyWidthRatio}
        onToggle={() => setHistoryCollapsed((collapsed) => !collapsed)}
        onResize={(ratio) => {
          setHistoryWidthRatio(ratio);
          setHistoryCollapsed(false);
        }}
      />
      <Layout.Content className="trinity-content">
        <Flex vertical className="workspace-frame">
          <Flex justify="space-between" align="center" gap={8} className="workspace-header">
            {historyCollapsed && (
              <Button
                size="small"
                onClick={newChat}
                aria-label="New conversation"
                title="New conversation"
              >
                ＋
              </Button>
            )}
            <div className="workspace-heading">
              {!sessionId && page === 'conversation' ? (
                <nav className="mode-tabs" aria-label="New conversation type">
                  {(['chat', 'work'] as const).map((value) => (
                    <Button
                      key={value}
                      disabled={creationPending}
                      type="text"
                      aria-pressed={mode === value && page === 'conversation'}
                      onClick={() => {
                        setMode(value);
                        setPage('conversation');
                      }}
                    >
                      {value === 'chat' ? 'Chat' : 'Work'}
                    </Button>
                  ))}
                </nav>
              ) : (
                <Typography.Text strong>
                  {page === 'conversation'
                    ? isMain
                      ? 'Main chat'
                      : activeSession?.kind === 'work'
                        ? 'Work'
                        : activeSession?.kind === 'chat'
                          ? 'Chat'
                          : 'Existing conversation'
                    : page.charAt(0).toUpperCase() + page.slice(1)}
                </Typography.Text>
              )}
              {sessionId && page === 'conversation' && (
                <span className="active-conversation-title" title={activeTitle}>
                  {activeTitle || 'Untitled conversation'}
                </span>
              )}
            </div>
            <Flex align="center" gap={8} wrap className="workspace-controls">
              {sessionId && (
                <Button
                  onClick={() => {
                    const source = sessionId;
                    const brief =
                      activeSession?.scope === 'team'
                        ? ''
                        : ([...items].reverse().find((item) => item.role === 'user')?.content ??
                          '');
                    if (brief) {
                      composerDrafts.current.set('new', brief);
                      if (user) sessionStorage.setItem(`trinity.draft:${user.id}:new`, brief);
                    }
                    newChat();
                    setMode('work');
                    setDraftOrigin(source);
                  }}
                >
                  Create related Work
                </Button>
              )}
              {sessionId &&
                !isMain &&
                items.some((item) => item.role === 'assistant' && item.final && item.messageId) && (
                  <Button
                    onClick={() => {
                      const answer = [...items]
                        .reverse()
                        .find((item) => item.role === 'assistant' && item.final && item.messageId);
                      if (answer?.messageId)
                        void client
                          .shareBack(sessionId, answer.messageId)
                          .then(() => message.success('Answer link shared to Main chat.'))
                          .catch((error: unknown) => message.error(String(error)));
                    }}
                  >
                    Share answer link
                  </Button>
                )}
              {activeSession?.workspaceUri && (
                <Tag title={activeSession.workspaceUri}>{workspaceLabel(activeSession, teams)}</Tag>
              )}
              {sessionId && (
                <UsagePanel
                  records={usageRecords}
                  scope="Session"
                  active={busy}
                  unrecordedTurns={unrecordedTurns}
                />
              )}
              <Button
                type="text"
                onClick={() => setSettingsOpen(true)}
                aria-label="Session settings"
              >
                <span aria-hidden="true">⚙</span>
                <span className="settings-button-label"> Session settings</span>
              </Button>
            </Flex>
          </Flex>
          <Modal
            open={settingsOpen}
            title="Session settings"
            footer={null}
            onCancel={() => setSettingsOpen(false)}
          >
            <div className="session-settings">
              {sessionId ? (
                <Typography.Paragraph type="secondary">
                  Chat gets its own workspace automatically. Work uses the workspace selected at
                  creation. Both can use files, browser research and commands under the session
                  permissions.
                </Typography.Paragraph>
              ) : null}
              {!sessionId && (
                <Typography.Paragraph>
                  Chat creates an automatic session workspace for ad-hoc work. Work setup lets you
                  select an existing workspace and permissions before Start.
                </Typography.Paragraph>
              )}
            </div>
          </Modal>
          <ApprovalModal
            approval={approval}
            onApprove={() => void onApprove('allowed')}
            onApprovePattern={(prefix) => void onApprove('allowed', prefix)}
            onReject={() => void onApprove('rejected')}
            onStop={() => void onCancelTurn()}
          />
          <Modal
            open={folderPickerOpen}
            title="Choose personal workspace folder"
            onCancel={() => setFolderPickerOpen(false)}
            onOk={() => {
              setWorkspace(
                browsePath ? { scope: 'personal', path: browsePath } : { scope: 'personal' },
              );
              setFolderPickerOpen(false);
            }}
            okText="Use this folder"
            okButtonProps={{ disabled: foldersLoading }}
          >
            <Typography.Paragraph>Your root / {browsePath || '(root)'}</Typography.Paragraph>
            <Button
              size="small"
              disabled={!browsePath || foldersLoading}
              onClick={() => setBrowsePath(browsePath.split('/').slice(0, -1).join('/'))}
            >
              ↑ Parent folder
            </Button>
            <List
              loading={foldersLoading}
              dataSource={folders}
              locale={{ emptyText: 'No subfolders' }}
              renderItem={(folder) => (
                <List.Item>
                  <Button
                    type="link"
                    onClick={() => setBrowsePath(browsePath ? `${browsePath}/${folder}` : folder)}
                  >
                    📁 {folder}
                  </Button>
                </List.Item>
              )}
            />
          </Modal>
          <TeamsModal
            open={teamsOpen}
            onClose={() => setTeamsOpen(false)}
            teams={teams}
            onChanged={() => {
              void refreshTeams();
              void refreshSessions();
            }}
          />
          <Flex justify="flex-end" className="turn-controls">
            {busy || (isMain && queuedPrompts.length > 0) ? (
              <Button size="small" danger onClick={() => void onCancelTurn()}>
                Cancel turn
              </Button>
            ) : null}
          </Flex>
          {chatPanel}
          {page === 'tasks' && (
            <AssistantTasks
              client={client}
              sessions={sessions.filter((session) => session.kind === 'work')}
              onOpen={switchSession}
            />
          )}
          {page === 'history' && <AssistantHistory client={client} onOpen={switchSession} />}
          {page === 'memory' && <AssistantMemory client={client} sessionId={sessionId} />}

          {page === 'scheduled' && (
            <ScheduledTasks client={client} sessions={sessions} onOpen={switchSession} />
          )}
          {page === 'computer' && (
            <PersonalComputer
              client={client}
              sessions={sessions}
              userId={user.id}
              mainSessionId={mainSessionId}
              preferredSessionId={sessionId}
              readOnly={user.role === 'viewer'}
            />
          )}
          {page === 'audit' && auditPanel && (
            <section className="audit-page">
              <Typography.Title level={3}>Audit log</Typography.Title>
              {auditPanel}
            </section>
          )}
        </Flex>
      </Layout.Content>
    </Layout>
  );
}

const RecentConversations = memo(function RecentConversations({
  sessions,
  sessionId,
  user,
  teams,
  onSelect,
  onExport,
  onDelete,
}: {
  sessions: SessionSummary[];
  sessionId: string | null;
  user: MeUser;
  teams: TeamView[];
  onSelect: (id: string) => void;
  onExport: (id: string) => Promise<void>;
  onDelete: (id: string) => void;
}): ReactElement {
  return (
    <List
      size="small"
      dataSource={sessions}
      locale={{ emptyText: 'No sessions yet' }}
      renderItem={(s) => (
        <List.Item
          onClick={() => onSelect(s.sessionId)}
          className={`history-item${s.sessionId === sessionId ? ' active' : ''}`}
          actions={[
            <Dropdown
              key="actions"
              menu={{
                items: [
                  { key: 'export', label: 'Export JSON' },
                  {
                    key: 'delete',
                    label: 'Delete',
                    danger: true,
                    disabled:
                      s.sessionRole === 'main' ||
                      user.role === 'viewer' ||
                      (user.role !== 'admin' && s.userId !== user.id),
                  },
                ],
                onClick: ({ key, domEvent }) => {
                  domEvent.stopPropagation();
                  if (key === 'export') void onExport(s.sessionId);
                  if (key === 'delete') onDelete(s.sessionId);
                },
              }}
            >
              <Button
                size="small"
                type="text"
                aria-label={`Actions for ${s.title || 'untitled conversation'}`}
                onClick={(event) => event.stopPropagation()}
              >
                ⋯
              </Button>
            </Dropdown>,
          ]}
        >
          <List.Item.Meta
            title={
              <Button
                type="text"
                className="history-title"
                aria-current={s.sessionId === sessionId ? 'true' : undefined}
                title={s.title || 'Untitled conversation'}
              >
                {s.title || 'Untitled conversation'}
              </Button>
            }
            description={
              <Flex gap={8} align="center">
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {new Date(s.createdAt).toLocaleString()}
                </Typography.Text>
                <Tag title={workspaceLabel(s, teams)} style={{ fontSize: 11, lineHeight: '14px' }}>
                  {s.kind === 'chat'
                    ? 'Chat'
                    : s.kind === 'work'
                      ? `Work · ${s.taskState?.replaceAll('_', ' ') ?? 'draft'}`
                      : 'Existing conversation'}
                </Tag>
              </Flex>
            }
          />
        </List.Item>
      )}
    />
  );
});

const bubbleRoles = {
  user: { placement: 'end' as const },
  assistant: { placement: 'start' as const },
};

function renderChatMessage(item: ChatItem): ReactElement {
  return <ChatMessageContent item={item} />;
}

const BrowserSessionContext = createContext<string | null>(null);

const ChatTranscript = memo(function ChatTranscript({
  items,
  sessionId = null,
}: {
  items: ChatItem[];
  sessionId?: string | null;
}): ReactElement {
  const bubbleItems = useMemo(
    () =>
      items.map((item) => ({
        key: item.key,
        role: item.role,
        content: item,
        messageRender: renderChatMessage,
      })),
    [items],
  );
  return (
    <BrowserSessionContext.Provider value={sessionId}>
      <Bubble.List className="chat-messages" items={bubbleItems} roles={bubbleRoles} />
    </BrowserSessionContext.Provider>
  );
});

const ChatMessageContent = memo(function ChatMessageContent({
  item,
}: {
  item: ChatItem;
}): ReactElement {
  if (item.role === 'assistant') return <AssistantContent item={item} content={item.content} />;
  return (
    <div>
      <div className="user-message-heading">
        <span>You</span>
        <MessageTimestamp at={item.at} />
      </div>
      {item.content.length > 0 && (
        <Typography.Paragraph
          copyable={{ text: item.content }}
          style={{ whiteSpace: 'pre-wrap', marginBottom: 8 }}
        >
          {item.content}
        </Typography.Paragraph>
      )}
      <AttachmentList attachments={item.attachments} />
    </div>
  );
});

/** Markdown-rendered assistant bubble: streaming deltas + tool calls below. */
const EMPTY_USAGE: ModelUsage[] = [];

function normalizeMarkdownTableHeadings(markdown: string): string {
  const lines = markdown.split('\n');
  const separatorRow = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;

  for (let index = 0; index < lines.length - 1; index += 1) {
    const headingAndHeader = /^(\s{0,3}#{1,6}[ \t]+[^|]+?)\s*(\|.+)$/.exec(lines[index]!);
    if (!headingAndHeader || !separatorRow.test(lines[index + 1]!)) continue;

    lines[index] = headingAndHeader[1]!.trimEnd();
    lines.splice(index + 1, 0, '', headingAndHeader[2]!);
    index += 2;
  }

  return lines.join('\n');
}

function AssistantContent({ item, content }: { item: ChatItem; content: string }): ReactElement {
  const browserSessionId = useContext(BrowserSessionContext);
  const browserTools = item.tools.filter((tool) => /^browser\(/.test(tool.title));
  return (
    <article className="assistant-response" aria-label="Trinity response">
      <div className="response-heading">
        <span className="response-author">Trinity</span>
        <MessageTimestamp at={item.at} />
      </div>
      <TurnProgress item={item} />
      {browserSessionId && browserTools.length > 0 && (
        <BrowserActivity
          client={client}
          sessionId={browserSessionId}
          running={
            !item.final &&
            !item.stopped &&
            !item.error &&
            browserTools.some((tool) => tool.status === 'in_progress')
          }
        />
      )}
      {content.length > 0 && (
        <div className="md" style={{ marginBottom: 8 }}>
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              a: (props) => <a {...props} target="_blank" rel="noreferrer" />,
              table: ({ children }) => (
                <div className="md-table-scroll">
                  <table>{children}</table>
                </div>
              ),
            }}
          >
            {normalizeMarkdownTableHeadings(content)}
          </ReactMarkdown>
          {item.streaming ? '▋' : ''}
        </div>
      )}
      <AttachmentList attachments={item.attachments} />
      {(item.tools.length > 0 || !!item.activity?.length) && (
        <details className="turn-activity">
          <summary>
            Execution details · {item.activity?.length ?? 0} updates · {item.tools.length} tools
          </summary>
          {!!item.activity?.length && (
            <ol className="turn-progress">
              {item.activity.map((entry, index) => (
                <li key={index}>
                  <Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>
                    {entry.content}
                  </Typography.Paragraph>
                </li>
              ))}
            </ol>
          )}
          <Collapse
            size="small"
            items={item.tools.map((tool) => ({
              key: tool.toolCallId,
              label: `${tool.status === 'in_progress' ? '⏳' : tool.status === 'failed' ? '❌' : '✅'} ${tool.title}`,
              children: (
                <Typography.Text code style={{ whiteSpace: 'pre-wrap' }}>
                  {tool.content ?? ''}
                </Typography.Text>
              ),
            }))}
          />
        </details>
      )}
      {!item.streaming && (
        <AnswerCitationList citations={item.citationList} renderImage={renderEvidenceImage} />
      )}
      {item.recall && <MemoryContextDisclosure receipt={item.recall} />}
      <UsagePanel records={item.usage ?? EMPTY_USAGE} scope="Turn" active={item.streaming} />
      {!item.streaming && content.trim().length > 0 && <ResponseActions content={content} />}
    </article>
  );
}

/** M4: renders message attachments — images inline, files as links. */
function renderEvidenceImage(uri: string): ReactElement {
  return <AttachmentItem attachment={{ kind: 'image', uri, mimeType: 'image/png' }} size={480} />;
}

function AttachmentList({ attachments }: { attachments: AttachmentView[] }) {
  if (attachments.length === 0) return null;
  return (
    <Flex gap={8} wrap style={{ marginBottom: 8 }}>
      {attachments.map((att) => (
        <AttachmentItem key={att.uri} attachment={att} />
      ))}
    </Flex>
  );
}

function AttachmentItem({
  attachment,
  size = 80,
}: {
  attachment: AttachmentView;
  size?: number;
}): ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | null = null;
    setFailed(false);
    setUrl(null);
    if (attachment.uri.startsWith('blob:') && !attachment.uri.startsWith('blob://')) {
      setUrl(attachment.uri);
      return () => controller.abort();
    }
    void client
      .fetchBlob(attachment.uri, controller.signal)
      .then((blob) => {
        if (controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(blob);
        setUrl(objectUrl);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      });
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [attachment.uri]);

  if (!url) {
    return (
      <Typography.Text type={failed ? 'danger' : 'secondary'}>
        {failed ? 'Attachment unavailable' : 'Loading attachment…'}
      </Typography.Text>
    );
  }

  if (attachment.kind === 'image') {
    return (
      <Image
        src={url}
        alt={attachment.mimeType ?? 'Uploaded image'}
        width={size}
        height={size}
        style={{ objectFit: 'cover', borderRadius: 8 }}
        preview={{ src: url }}
      />
    );
  }

  return (
    <a href={url} target="_blank" rel="noreferrer">
      📄 {attachment.mimeType ?? 'document'}
    </a>
  );
}

/** M3: antd Modal bound to a pending approval request (docs/design.md §11.5). */
function ApprovalModal({
  approval,
  onApprove,
  onReject,
  onStop,
  onApprovePattern,
}: {
  approval: PendingApproval | null;
  onApprove: () => void;
  onReject: () => void;
  onStop: () => void;
  onApprovePattern: (prefix: string[]) => void;
}) {
  const [pattern, setPattern] = useState('');
  useEffect(() => {
    let command = '';
    try {
      command = (JSON.parse(approval?.argsPreview ?? '{}') as { command?: string }).command ?? '';
    } catch {
      command = '';
    }
    setPattern(command.trim().split(/\s+/)[0] ?? '');
  }, [approval?.approvalId, approval?.argsPreview]);
  const prefix = pattern.trim().split(/\s+/).filter(Boolean);
  const valid = prefix.length > 0 && prefix.every((word) => /^[a-zA-Z0-9_./:@=+-]+$/.test(word));
  return (
    <Modal
      open={approval !== null}
      title={`Approval required: ${approval?.toolName ?? ''}`}
      okText="Allow once"
      cancelText="Reject"
      onOk={onApprove}
      onCancel={onReject}
      maskClosable={false}
      keyboard={false}
      footer={(_, { OkBtn, CancelBtn }) => (
        <>
          <Button onClick={onStop}>Stop task</Button>
          {approval?.toolName === 'bash' && (
            <Button disabled={!valid} onClick={() => onApprovePattern(prefix)}>
              Allow pattern for conversation
            </Button>
          )}
          <CancelBtn />
          <OkBtn />
        </>
      )}
    >
      {approval?.toolName === 'bash' && (
        <>
          <Typography.Paragraph>
            Allow commands starting with this executable and arguments for this conversation:
          </Typography.Paragraph>
          <Input
            aria-label="Command prefix"
            value={pattern}
            onChange={(event) => setPattern(event.target.value)}
          />
        </>
      )}
      <Typography.Paragraph>The agent wants to run a gated tool call:</Typography.Paragraph>
      <Typography.Text code style={{ whiteSpace: 'pre-wrap', display: 'block' }}>
        {approval?.title ?? ''}
      </Typography.Text>
      <Typography.Paragraph
        type="secondary"
        style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflowY: 'auto', marginTop: 8 }}
      >
        {approval?.argsPreview ?? ''}
      </Typography.Paragraph>
    </Modal>
  );
}

/** Team management: create teams, see members, add members by email. */
function TeamsModal({
  open,
  onClose,
  teams,
  onChanged,
}: {
  open: boolean;
  onClose: () => void;
  teams: TeamView[];
  onChanged: () => void;
}) {
  const { message } = AntdApp.useApp();
  const [newTeam, setNewTeam] = useState('');
  const [memberEmails, setMemberEmails] = useState<Record<string, string>>({});

  const createTeam = async () => {
    const name = newTeam.trim();
    if (!name) return;
    try {
      await client.createTeam(name);
      setNewTeam('');
      onChanged();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  const addMember = async (teamId: string) => {
    const email = (memberEmails[teamId] ?? '').trim();
    if (!email) return;
    try {
      await client.addTeamMember(teamId, email);
      setMemberEmails((prev) => ({ ...prev, [teamId]: '' }));
      onChanged();
    } catch (err) {
      message.error(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Modal open={open} title="Teams & shared workspaces" footer={null} onCancel={onClose}>
      <Flex vertical gap={12}>
        <Flex gap={8}>
          <Input
            placeholder="New team name"
            value={newTeam}
            onChange={(e) => setNewTeam(e.target.value)}
            onPressEnter={() => void createTeam()}
          />
          <Button type="primary" onClick={() => void createTeam()}>
            Create
          </Button>
        </Flex>
        {teams.length === 0 && (
          <Typography.Text type="secondary">
            Create a team to share a workspace, then invite members by email.
          </Typography.Text>
        )}
        {teams.map((t) => (
          <div key={t.teamId}>
            <Typography.Text strong>{t.name}</Typography.Text>
            <div style={{ marginBlock: 4 }}>
              {t.members.map((m) => (
                <Tag key={m.userId}>
                  {m.email} · {m.role}
                </Tag>
              ))}
            </div>
            <Flex gap={8}>
              <Input
                placeholder="member@example.com"
                value={memberEmails[t.teamId] ?? ''}
                onChange={(e) =>
                  setMemberEmails((prev) => ({ ...prev, [t.teamId]: e.target.value }))
                }
                onPressEnter={() => void addMember(t.teamId)}
              />
              <Button onClick={() => void addMember(t.teamId)}>Add member</Button>
            </Flex>
          </div>
        ))}
      </Flex>
    </Modal>
  );
}

/** Admin audit viewer (docs/design.md §13): paginated antd Table over /api/audit. */
function AuditTable() {
  const { message } = AntdApp.useApp();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);

  const load = useCallback(
    async (p: number) => {
      setLoading(true);
      try {
        const result = await client.queryAudit({ limit: 20, offset: (p - 1) * 20 });
        setRows(result.records as AuditRow[]);
        setTotal(result.total);
        setPage(p);
      } catch (err) {
        message.error(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [message],
  );

  useEffect(() => {
    void load(1);
  }, [load]);

  return (
    <div style={{ flex: 1, overflowY: 'auto', paddingBlock: 16 }}>
      <Table<AuditRow>
        size="small"
        rowKey="id"
        scroll={{ x: 800 }}
        loading={loading}
        dataSource={rows}
        pagination={{
          current: page,
          total,
          pageSize: 20,
          onChange: (p) => void load(p),
        }}
        columns={[
          { title: 'Time', dataIndex: 'at', render: (v: string) => new Date(v).toLocaleString() },
          { title: 'User', dataIndex: 'userId' },
          { title: 'Action', dataIndex: 'action' },
          { title: 'Target', dataIndex: 'target' },
          {
            title: 'Result',
            dataIndex: 'result',
            render: (v: string) =>
              v === 'ok' ? '✅ ok' : v === 'denied' ? '⛔ denied' : `❌ ${v}`,
          },
          {
            title: 'Session',
            dataIndex: 'sessionId',
            render: (v?: string) => v?.slice(0, 8) ?? '',
          },
        ]}
      />
    </div>
  );
}
