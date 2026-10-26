import type { SandboxPort } from '@trinity-harness/contracts';
import { turnMessageProjection } from '@trinity-harness/contracts';
import {
  scheduleCreateSchema,
  scheduleListSchema,
  inboxListSchema,
} from '@trinity-harness/contracts';
import {
  environmentResponseSchema,
  environmentNodeDrainResultSchema,
  browserPreviewSchema,
  browserInteractionRequestSchema,
  browserInteractionResultSchema,
  type EnvironmentPort,
  type EnvironmentMaintenancePort,
} from '@trinity-harness/contracts';
import {
  chatWorkspaceDir,
  runOrderedPrompts,
  saveWorkspaceAttachment,
  sessionWorkspaceRoot,
} from '@trinity-harness/core';
import type { SessionRunPort, TurnTask } from '@trinity-harness/contracts';
import {
  memoryCommandSchema,
  historyQuerySchema,
  type MemoryStorePort,
  type ConversationIndexPort,
} from '@trinity-harness/contracts';
import { validateMemoryCommand } from '@trinity-harness/core';
import type {
  AgentLoop,
  AgentTaskQueue,
  ApprovalHub,
  ApprovalRequest,
  ApprovalStore,
  AuditEmitter,
  AuditStore,
  BlobStore,
  BrowserPreviewPort,
  BrowserInteractionPort,
  ScheduleStore,
  ContentBlock,
  EventSink,
  Identity,
  LiveEventSubscriber,
  LoopEvent,
  PasswordHasher,
  PermissionPolicy,
  QuotaAdminPort,
  SessionEvent,
  SessionEventReader,
  SessionMeta,
  SessionMetaStore,
  SessionStore,
  TeamStore,
  TokenService,
  TurnCancellationPort,
  UsagePort,
  UserStore,
} from '@trinity-harness/contracts';
import {
  approvalResponseSchema,
  newId,
  personalFoldersQuerySchema,
  serverEventSchema,
  workspaceSelectionSchema,
} from '@trinity-harness/shared';
import type { ServerEvent } from '@trinity-harness/shared';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';
import { resolveBrowserImage } from '@trinity-harness/core';

import { parsePermissionPolicy, tenantQuotaSchema, windowStart } from '@trinity-harness/contracts';

import { listPersonalFolders, personalWorkspaceDir, workspaceDirFor } from './workspace.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Authenticated principal (present iff the server was built with auth). */
    identity?: Identity;
  }
}

/** Tenant id used in audit rows when the tenant cannot be determined (failed logins). */
export const NIL_TENANT = '00000000-0000-0000-0000-000000000000';

/** Inbound payload validation at the HTTP boundary (AGENTS.md §5). */
const createSessionSchema = z.object({
  kind: z.enum(['chat', 'work']).optional(),
  sessionRole: z.enum(['main', 'side', 'task']).optional(),
  creationOperationId: z.uuid().optional(),
  originSessionId: z.uuid().optional(),
  title: z.string().min(1).max(200).optional(),
  /** M3: permission preset name ('workspace-write' | 'read-only' | 'danger-full-access') or a JSON policy. */
  policy: z.string().min(1).max(4000).optional(),
  /**
   * Workspace scope: personal (default, `$WORKSPACE_ROOT/<user_id>`) or a
   * team the creator belongs to (`$WORKSPACE_ROOT/<team_id>`). The directory
   * becomes the session sandbox root.
   */
  workspace: workspaceSelectionSchema.optional(),
});

const postMessageSchema = z.object({
  text: z.string().min(1).max(100_000),
  /**
   * M4 multimodal: `blob://` attachments previously uploaded via
   * POST /api/sessions/:id/attachments (docs/design.md §10).
   */
  attachments: z
    .array(z.object({ uri: z.string().min(1).max(500), mimeType: z.string().min(1).max(200) }))
    .max(8)
    .optional(),
});

const setPolicySchema = z.object({
  policy: z.string().min(1).max(4000),
});

const approvalRespondSchema = approvalResponseSchema;

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(200),
});

const createUserSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8).max(200),
  role: z.enum(['admin', 'developer', 'viewer']),
});

const postParamsSchema = z.object({
  sessionId: z.uuid(),
});

const auditQuerySchema = z.object({
  sessionId: z.uuid().optional(),
  action: z.string().min(1).max(100).optional(),
  limit: z.coerce.number().int().positive().max(1000).optional(),
  offset: z.coerce.number().int().nonnegative().optional(),
});

const eventsQuerySchema = z.object({
  afterSeq: z.coerce.number().int().nonnegative().optional(),
  token: z.string().optional(),
});

function credentialMemoryRequest(text: string): boolean {
  if (!/^(remember\b|change my\b)/iu.test(text.trim())) return false;
  try {
    validateMemoryCommand({
      operationId: NIL_TENANT,
      memoryId: NIL_TENANT,
      expectedRevision: 0,
      operation: 'save',
      subject: 'Me',
      predicate: 'explicit request',
      value: text,
    });
    return false;
  } catch {
    return true;
  }
}

function preview(value: unknown, max = 2000): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function blocksToText(content: readonly { kind: string; text?: string; uri?: string }[]): string {
  return content
    .map((b) =>
      b.kind === 'reasoning'
        ? `[reasoning]\n${b.text ?? ''}`
        : b.kind === 'text'
          ? (b.text ?? '')
          : `[${b.kind}: ${b.uri ?? ''}]`,
    )
    .join('\n');
}

/** M4: attachment byte-size ceiling (images + PDFs, docs/design.md §10). */
const MAX_ATTACHMENT_BYTES = 20 * 1024 * 1024;
/** Blob-served attachment MIME allowlist (mirrors core's ingest list). */
const ATTACHMENT_MIME_ALLOWLIST = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
];

/**
 * Builds the `message/user` content blocks for a prompt: text first, then
 * attachment references (already `blob://` URIs — uploads happen via the
 * attachments endpoint or ACP image/file resources are inlined into blobs
 * by `acpBlocksToContent`).
 */
function promptContent(
  text: string,
  attachments: readonly { uri: string; mimeType: string }[] | undefined,
): ContentBlock[] {
  const blocks: ContentBlock[] = [{ kind: 'text', text }];
  for (const att of attachments ?? []) {
    blocks.push(
      att.mimeType === 'application/pdf'
        ? { kind: 'file', uri: att.uri, mimeType: att.mimeType }
        : { kind: 'image', uri: att.uri, mimeType: att.mimeType },
    );
  }
  return blocks;
}

/**
 * ACP `session/prompt` content blocks → internal content blocks. Supports
 * `{type:"text",text}`, and image/file resources in both ACP shape
 * (`{type:"image",resource:{uri|data,mimeType}}`) and flat `{uri}` form.
 * Base64 `data` resources are stored into the BlobStore — the event log only
 * ever carries `blob://` references (docs/design.md §10).
 */
async function acpBlocksToContent(
  blobs: BlobStore | undefined,
  raw: unknown,
): Promise<ContentBlock[] | null> {
  const resourceSchema = z.object({
    uri: z.string().min(1).max(2000).optional(),
    mimeType: z.string().min(1).max(200).optional(),
    /** base64 inline data (ACP resource form). */
    data: z
      .string()
      .max(MAX_ATTACHMENT_BYTES * 2)
      .optional(),
  });
  const blockSchema = z.discriminatedUnion('type', [
    z.object({ type: z.literal('text'), text: z.string().min(1).max(100_000) }),
    z.object({
      type: z.literal('image'),
      resource: resourceSchema.optional(),
      uri: z.string().optional(),
      mimeType: z.string().optional(),
      data: z
        .string()
        .max(MAX_ATTACHMENT_BYTES * 2)
        .optional(),
    }),
    z.object({
      type: z.literal('file'),
      resource: resourceSchema.optional(),
      uri: z.string().optional(),
      mimeType: z.string().optional(),
      data: z
        .string()
        .max(MAX_ATTACHMENT_BYTES * 2)
        .optional(),
    }),
  ]);
  const parsed = z.array(blockSchema).min(1).max(16).safeParse(raw);
  if (!parsed.success) return null;

  const blocks: ContentBlock[] = [];
  for (const block of parsed.data) {
    if (block.type === 'text') {
      blocks.push({ kind: 'text', text: block.text });
      continue;
    }
    const resource = block.resource ?? {
      ...(block.uri !== undefined ? { uri: block.uri } : {}),
      ...(block.mimeType !== undefined ? { mimeType: block.mimeType } : {}),
      ...(block.data !== undefined ? { data: block.data } : {}),
    };
    const kind = block.type === 'image' ? ('image' as const) : ('file' as const);
    if (resource.data !== undefined) {
      if (!blobs) {
        throw new Error('inline attachments require a configured blob store');
      }
      const bytes = Buffer.from(resource.data, 'base64');
      if (bytes.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error(`attachment exceeds ${MAX_ATTACHMENT_BYTES} bytes`);
      }
      const mime =
        resource.mimeType ?? (kind === 'image' ? 'image/png' : 'application/octet-stream');
      const blob = await blobs.put(undefined, bytes, { mimeType: mime });
      blocks.push({ kind, uri: blob.uri, mimeType: mime });
    } else if (resource.uri !== undefined) {
      if (resource.uri.startsWith('blob://')) {
        blocks.push({
          kind,
          uri: resource.uri,
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        });
      } else if (kind === 'image') {
        // Plain http(s) image URLs pass through as references.
        blocks.push({
          kind,
          uri: resource.uri,
          ...(resource.mimeType ? { mimeType: resource.mimeType } : {}),
        });
      } else {
        return null; // file blocks must be blob:// or inline data
      }
    } else {
      return null;
    }
  }
  return blocks;
}

/** LoopEvent → ACP-flavored wire events (docs/design.md §11.4). */
export function toServerEvent(sessionId: string, event: LoopEvent): ServerEvent | null {
  switch (event.type) {
    case 'model/usage':
      return { type: 'model/usage', sessionId, usage: event.usage };
    case 'text-delta':
      return {
        type: 'session/update',
        sessionId,
        update: { kind: 'agent_message_chunk', text: event.text },
      };
    case 'reasoning-delta':
      return {
        type: 'session/update',
        sessionId,
        update: { kind: 'agent_thought_chunk', text: event.text },
      };
    case 'message/assistant':
      return {
        type: 'message/committed',
        sessionId,
        message: {
          role: 'assistant',
          content: event.content,
          ...(event.phase ? { phase: event.phase } : {}),
          ...(event.citationList ? { citationList: event.citationList } : {}),
        },
      };
    case 'tool/call':
      return {
        type: 'session/update',
        sessionId,
        update: {
          kind: 'tool_call',
          toolCallId: event.call.id,
          title: `${event.call.name}(${preview(event.call.args, 120)})`,
          status: 'in_progress',
        },
      };
    case 'tool/result':
      return {
        type: 'session/update',
        sessionId,
        update: {
          kind: 'tool_call',
          toolCallId: event.callId,
          title: '',
          status: event.result.isError ? 'failed' : 'completed',
          content: preview(event.result.value),
        },
      };
    case 'approval-requested':
      return {
        type: 'session/update',
        sessionId,
        update: {
          kind: 'permission_request',
          approvalId: event.approvalId,
          toolCallId: event.call.id,
          toolName: event.call.name,
          title: `${event.call.name}(${preview(event.call.args, 120)})`,
          argsPreview: event.argsPreview,
          status: 'pending',
        },
      };
    case 'approval-resolved':
      return {
        type: 'session/turn_status',
        sessionId,
        status: 'running',
        detail: `approval ${event.outcome} by ${event.decidedBy}`,
      };
    case 'turn/end':
      if (event.reason === 'error') {
        return { type: 'error', sessionId, message: event.detail ?? 'turn failed' };
      }
      return {
        type: 'session/turn_status',
        sessionId,
        status: event.reason === 'aborted' ? 'aborted' : 'completed',
      };
    case 'context/compacted':
      return {
        type: 'session/turn_status',
        sessionId,
        status: 'running',
        detail: `context compacted (events ${event.fromSeq}-${event.toSeq})`,
      };
    default:
      return null;
  }
}

/** Media blocks of a committed message (M4 UI rendering). */
function mediaOf(
  content: readonly ContentBlock[],
): { kind: 'image' | 'file'; uri: string; mimeType?: string }[] | undefined {
  const media = content.filter((b) => b.kind === 'image' || b.kind === 'file');
  return media.length > 0
    ? media.map((b) =>
        b.kind === 'image'
          ? { kind: 'image' as const, uri: b.uri, ...(b.mimeType ? { mimeType: b.mimeType } : {}) }
          : { kind: 'file' as const, uri: b.uri, ...(b.mimeType ? { mimeType: b.mimeType } : {}) },
      )
    : undefined;
}

/** SessionEvent (log replay / stream) → wire events, for SSE with seq ids. */
export function logEventToServerEvent(sessionId: string, event: SessionEvent): ServerEvent | null {
  switch (event.type) {
    case 'model/usage':
      return { type: 'model/usage', sessionId, usage: event.usage };
    case 'message/user':
      return {
        type: 'message/committed',
        sessionId,
        message: {
          role: 'user',
          id: event.eventId,
          at: event.at,
          content: blocksToText(event.content),
          ...(mediaOf(event.content) !== undefined ? { attachments: mediaOf(event.content) } : {}),
        },
      };
    case 'message/assistant':
      return {
        type: 'message/committed',
        sessionId,
        message: {
          role: 'assistant',
          content: blocksToText(event.content),
          at: event.at,
          ...(event.phase ? { phase: event.phase } : {}),
          ...(event.citationList ? { citationList: event.citationList } : {}),
        },
      };
    case 'tool/call':
      return {
        type: 'session/update',
        sessionId,
        update: {
          kind: 'tool_call',
          toolCallId: event.callId,
          title: `${event.name}(${preview(event.args, 120)})`,
          status: 'in_progress',
        },
      };
    case 'tool/result':
      return {
        type: 'session/update',
        sessionId,
        update: {
          kind: 'tool_call',
          toolCallId: event.callId,
          title: '',
          status: event.isError ? 'failed' : 'completed',
          content: preview(event.value),
        },
      };
    case 'approval/requested':
      return {
        type: 'session/update',
        sessionId,
        update: {
          kind: 'permission_request',
          approvalId: event.approvalId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          title: `${event.toolName}(${event.argsPreview.slice(0, 120)})`,
          argsPreview: event.argsPreview,
          status: 'pending',
        },
      };
    case 'approval/resolved':
      return {
        type: 'session/turn_status',
        sessionId,
        status: 'running',
        detail: `approval ${event.outcome} by ${event.decidedBy}`,
      };
    case 'activity/reference':
      return {
        type: 'session/activity',
        sessionId,
        sourceSessionId: event.sourceSessionId,
        sourceEventId: event.sourceEventId,
        kind: event.kind,
      };
    case 'memory/selection':
      return { type: 'session/memory_selection', sessionId, receipt: event.receipt };
    case 'prompt/queued':
      return {
        type: 'session/prompt_queue',
        sessionId,
        promptId: event.promptId,
        state: 'queued',
        text: blocksToText(event.content),
      };
    case 'prompt/discarded':
      return {
        type: 'session/prompt_queue',
        sessionId,
        promptId: event.promptId,
        state: 'cancelled',
      };
    case 'turn/start':
      return { type: 'session/turn_status', sessionId, status: 'running' };
    case 'turn/end':
      if (event.reason === 'error') {
        return { type: 'error', sessionId, message: event.detail ?? 'turn failed' };
      }
      return {
        type: 'session/turn_status',
        sessionId,
        status: event.reason === 'aborted' ? 'aborted' : 'completed',
      };
    default:
      return null;
  }
}

export interface ServerAuthDeps {
  tokens: TokenService;
  users: UserStore;
  metas: SessionMetaStore;
  hasher: PasswordHasher;
}

export interface ServerDeps {
  browserPreview?: BrowserPreviewPort;
  browserInteraction?: BrowserInteractionPort;
  schedules?: ScheduleStore;
  environments?: EnvironmentPort;
  environmentMaintenance?: EnvironmentMaintenancePort;
  firecrackerMaintenanceToken?: string;
  sessionRuns?: SessionRunPort | undefined;
  memory?: MemoryStorePort | undefined;
  conversationIndex?: ConversationIndexPort | undefined;
  store: SessionStore;
  workspaceRoot: string;
  workspaceSandbox?: (sessionId: string, root: string) => SandboxPort;
  /** Inline mode (M1/tests): runs the Loop in this process, sandboxed to the session workspace. */
  createLoop?: (sessionId: string, workspaceRoot: string) => AgentLoop;
  /** Distributed mode (M2): enqueue turns for agent-worker. */
  queue?: AgentTaskQueue;
  /** Distributed SSE: durable session-event replay + live deltas. */
  eventReader?: SessionEventReader;
  liveEvents?: LiveEventSubscriber;
  /** Present ⇒ all /api routes except health/auth require a bearer token. */
  auth?: ServerAuthDeps;
  /** Team directory (docs/design.md §15); present ⇒ team workspaces enabled. */
  teams?: TeamStore;
  audit?: AuditEmitter;
  /** Admin audit query endpoint (requires auth). */
  auditQuery?: AuditStore;
  /** M3: server-side human approval fan-out (docs/design.md §12.2). */
  approvals?: ApprovalHub;
  /** M3: durable approval trail (approvals table). */
  approvalStore?: ApprovalStore;
  /** M3: abort an in-flight turn (session/cancel); usually the worker handle. */
  turns?: TurnCancellationPort;
  /** M3: permission policy for new sessions when the client picks none. */
  defaultPolicy?: PermissionPolicy;
  /** M4: attachment + spill storage (docs/design.md §10). */
  blobs?: BlobStore;
  /**
   * M5: token metering read side (docs/design.md §17). Powers /api/usage and
   * the admin quota endpoints; the loop-side recording/gate runs wherever
   * the Loop runs (agent-worker in distributed mode, this process inline).
   */
  usage?: UsagePort;
  /** M5: tenant quota administration (admin-only REST endpoint). */
  quotaAdmin?: QuotaAdminPort;
}

export interface BuildServerOptions {
  logger?: boolean;
}

function canAccess(identity: Identity, meta: SessionMeta): boolean {
  return (
    meta.tenantId === identity.tenantId &&
    (identity.role === 'admin' || meta.userId === identity.userId)
  );
}

function tokenFrom(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim();
  // EventSource cannot set headers; the SSE endpoint accepts ?token= instead.
  const query = req.query as Record<string, unknown>;
  return typeof query['token'] === 'string' ? query['token'] : null;
}

/**
 * HTTP + SSE surface. Composition-root input is fully injected: M1-style
 * inline mode (createLoop) and M2 distributed mode (queue + eventReader +
 * liveEvents) are both supported, auth/RBAC is enabled by providing `auth`.
 */
export async function buildServer(
  deps: ServerDeps,
  opts?: BuildServerOptions,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: opts?.logger ?? false });
  const subscribers = new Map<string, Set<(event: ServerEvent) => void>>();
  const liveSubs = new Map<string, Set<(event: ServerEvent) => void>>();

  const broadcast = (sessionId: string, event: ServerEvent): void => {
    for (const listener of subscribers.get(sessionId) ?? []) {
      try {
        listener(event);
      } catch {
        // A dead listener must not break broadcasting; cleanup happens on close.
      }
    }
  };

  const emitAudit = (record: Parameters<AuditEmitter['emit']>[0]): void => {
    try {
      deps.audit?.emit(record);
    } catch {
      // Audit emission never breaks the user flow (at-least-once, §13).
    }
  };

  const auth = deps.auth;
  if (auth) {
    app.addHook('onRequest', async (req, reply) => {
      const url = req.raw.url ?? '';
      if (
        url === '/api/health' ||
        url.startsWith('/api/auth/') ||
        /^\/api\/ops\/firecracker-nodes\/[a-z0-9-]{1,63}\/(?:drain|resume)(?:\?|$)/u.test(url)
      )
        return;
      const token = tokenFrom(req);
      const identity = token ? await auth.tokens.verify(token) : null;
      if (!identity) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      req.identity = identity;
    });
  }

  const maintenanceAuthorized = (req: FastifyRequest): boolean => {
    const expected = deps.firecrackerMaintenanceToken;
    const header = req.headers.authorization;
    if (!expected || !header?.startsWith('Bearer ')) return false;
    const actual = Buffer.from(header.slice('Bearer '.length).trim());
    const secret = Buffer.from(expected);
    return actual.length === secret.length && timingSafeEqual(actual, secret);
  };
  app.post('/api/ops/firecracker-nodes/:nodeId/drain', async (req, reply) => {
    if (!maintenanceAuthorized(req)) return reply.code(401).send({ error: 'unauthorized' });
    if (!deps.environmentMaintenance)
      return reply.code(503).send({ error: 'Firecracker maintenance unavailable' });
    const params = z
      .object({ nodeId: z.string().regex(/^[a-z0-9-]{1,63}$/) })
      .safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid node id' });
    if (
      !z
        .object({})
        .strict()
        .safeParse(req.body ?? {}).success
    )
      return reply.code(400).send({ error: 'empty request body required' });
    const cancelled = new AbortController();
    const abort = (): void => {
      if (!reply.raw.writableFinished) cancelled.abort();
    };
    req.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    try {
      const result = await deps.environmentMaintenance.drainNode(
        params.data.nodeId,
        cancelled.signal,
      );
      environmentNodeDrainResultSchema.parse(result);
      return reply.code(result.remaining === 0 ? 200 : 409).send(result);
    } catch (error) {
      if ((error as { code?: string }).code === 'UNKNOWN_NODE')
        return reply.code(404).send({ error: 'unknown Firecracker node' });
      return reply
        .code(503)
        .send({ error: 'node drain could not be confirmed; node remains drained' });
    } finally {
      req.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abort);
    }
  });
  app.post('/api/ops/firecracker-nodes/:nodeId/resume', async (req, reply) => {
    if (!maintenanceAuthorized(req)) return reply.code(401).send({ error: 'unauthorized' });
    if (!deps.environmentMaintenance)
      return reply.code(503).send({ error: 'Firecracker maintenance unavailable' });
    const params = z
      .object({ nodeId: z.string().regex(/^[a-z0-9-]{1,63}$/) })
      .safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid node id' });
    if (
      !z
        .object({})
        .strict()
        .safeParse(req.body ?? {}).success
    )
      return reply.code(400).send({ error: 'empty request body required' });
    try {
      await deps.environmentMaintenance.resumeNode(params.data.nodeId);
      return reply.code(200).send(
        z.object({ nodeId: z.string(), state: z.literal('ready') }).parse({
          nodeId: params.data.nodeId,
          state: 'ready',
        }),
      );
    } catch (error) {
      if ((error as { code?: string }).code === 'UNKNOWN_NODE')
        return reply.code(404).send({ error: 'unknown Firecracker node' });
      if ((error as { code?: string }).code === 'NODE_ACTIVE')
        return reply.code(409).send({ error: 'active environments prevent node resume' });
      return reply.code(503).send({ error: 'node remains in maintenance' });
    }
  });

  app.get('/api/me/environment', async (req, reply) => {
    if (!deps.environments || !req.identity) return { available: false, environment: null };
    const cancelled = new AbortController();
    const abort = (): void => {
      if (!reply.raw.writableFinished) cancelled.abort();
    };
    req.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    try {
      const environment = await deps.environments.get(
        req.identity,
        AbortSignal.any([cancelled.signal, AbortSignal.timeout(10_000)]),
      );
      return reply
        .header('cache-control', 'private, no-store')
        .send(environmentResponseSchema.parse({ available: true, environment }));
    } catch {
      return reply.code(503).send({ error: 'environment status unavailable' });
    } finally {
      req.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abort);
    }
  });
  for (const action of ['wake', 'suspend'] as const)
    app.post(`/api/me/environment/${action}`, async (req, reply) => {
      if (!deps.environments || !req.identity)
        return reply.code(503).send({ error: 'personal environments unavailable' });
      if (req.identity.role === 'viewer') return reply.code(403).send({ error: 'read-only role' });
      if (
        !z
          .object({})
          .strict()
          .safeParse(req.body ?? {}).success
      )
        return reply.code(400).send({ error: 'environment identity is server-owned' });
      const currentUser = await auth?.users.findById(req.identity.userId);
      if (
        !currentUser ||
        currentUser.tenantId !== req.identity.tenantId ||
        currentUser.role === 'viewer'
      )
        return reply.code(403).send({ error: 'execution access revoked' });
      const cancelled = new AbortController();
      const abort = (): void => {
        if (!reply.raw.writableFinished) cancelled.abort();
      };
      req.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      try {
        const result = await deps.environments[action](req.identity, cancelled.signal);
        return reply
          .code(202)
          .send(environmentResponseSchema.parse({ available: true, environment: result }));
      } catch {
        return reply.code(409).send({ error: 'environment capacity or host recovery required' });
      } finally {
        req.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', abort);
      }
    });
  app.get('/api/schedules', async (req) =>
    scheduleListSchema.parse({
      available: !!deps.schedules && !!req.identity,
      schedules: deps.schedules && req.identity ? await deps.schedules.list(req.identity) : [],
    }),
  );
  app.post('/api/schedules', async (req, reply) => {
    if (!deps.schedules || !req.identity)
      return reply.code(503).send({ error: 'scheduling unavailable' });
    if (req.identity.role === 'viewer') return reply.code(403).send({ error: 'read-only role' });
    const input = scheduleCreateSchema.safeParse(req.body);
    if (!input.success) return reply.code(400).send({ error: 'invalid schedule' });
    try {
      return await deps.schedules.create(req.identity, input.data, new Date());
    } catch {
      return reply.code(409).send({ error: 'schedule conflicts or owned personal Work required' });
    }
  });
  app.patch('/api/schedules/:id', async (req, reply) => {
    if (!deps.schedules || !req.identity)
      return reply.code(503).send({ error: 'scheduling unavailable' });
    if (req.identity.role === 'viewer') return reply.code(403).send({ error: 'read-only role' });
    const params = z.object({ id: z.uuid() }).safeParse(req.params);
    const input = z
      .object({ revision: z.number().int().positive(), enabled: z.boolean() })
      .strict()
      .safeParse(req.body);
    if (!params.success || !input.success)
      return reply.code(400).send({ error: 'invalid schedule change' });
    try {
      const result = await deps.schedules.setEnabled(
        req.identity,
        params.data.id,
        input.data.revision,
        input.data.enabled,
        new Date(),
      );
      return result ?? reply.code(409).send({ error: 'schedule missing or revision changed' });
    } catch {
      return reply.code(409).send({ error: 'schedule has no future occurrence' });
    }
  });
  app.get('/api/inbox', async (req) =>
    inboxListSchema.parse({
      available: !!deps.schedules && !!req.identity,
      items: deps.schedules && req.identity ? await deps.schedules.inbox(req.identity) : [],
    }),
  );
  app.post('/api/inbox/:id/ack', async (req, reply) => {
    if (!deps.schedules || !req.identity)
      return reply.code(503).send({ error: 'inbox unavailable' });
    const params = z.object({ id: z.uuid() }).safeParse(req.params);
    if (!params.success) return reply.code(400).send({ error: 'invalid notification' });
    await deps.schedules.acknowledge(req.identity, params.data.id, new Date());
    return { ok: true };
  });

  if (deps.liveEvents) {
    // Live deltas (Pub/Sub) are independent of auth — sessions are already
    // authorized per-connection in the SSE route.
    const sub = deps.liveEvents.subscribe((sessionId, loopEvent) => {
      const wire = toServerEvent(sessionId, loopEvent);
      if (!wire) return;
      for (const listener of liveSubs.get(sessionId) ?? []) {
        try {
          listener(serverEventSchema.parse(wire));
        } catch {
          // ignore dead listeners; cleanup on connection close
        }
      }
    });
    app.addHook('onClose', async () => {
      sub.dispose();
    });
  }

  const sinkFor = (sessionId: string): EventSink => ({
    emit: (loopEvent) => {
      const wire = toServerEvent(sessionId, loopEvent);
      if (wire) {
        broadcast(sessionId, serverEventSchema.parse(wire));
      }
    },
  });

  // Controllers own only live resources; cancellation intent remains in PG.
  const inlineTurns = new Map<string, Set<AbortController>>();
  const inlineJobs = new Set<Promise<unknown>>();
  const runInline = (sessionId: string, run: (signal: AbortSignal) => Promise<unknown>): void => {
    // Flush the caller's committed prompt before streaming the response.
    broadcast(sessionId, { type: 'session/turn_status', sessionId, status: 'running' });
    const controller = new AbortController();
    const controllers = inlineTurns.get(sessionId) ?? new Set<AbortController>();
    controllers.add(controller);
    inlineTurns.set(sessionId, controllers);
    const job = run(controller.signal)
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        broadcast(sessionId, {
          type: 'error',
          sessionId,
          message: err instanceof Error ? err.message : String(err),
        });
      })
      .finally(() => {
        controllers.delete(controller);
        if (controllers.size === 0) inlineTurns.delete(sessionId);
        inlineJobs.delete(job);
      });
    inlineJobs.add(job);
  };
  app.addHook('onReady', async () => {
    if (deps.queue || !deps.createLoop || !deps.sessionRuns?.pending) return;
    let cursor: string | undefined;
    for (;;) {
      const tasks = await deps.sessionRuns.pending(cursor);
      for (const task of tasks)
        runInline(task.sessionId, (signal) =>
          runOrderedPrompts(
            deps.sessionRuns!,
            deps.store,
            task,
            async (ordered) => {
              const meta = await auth?.metas.get(ordered.sessionId);
              if (!meta || meta.closedAt || meta.sessionRole !== 'main')
                throw new Error('Main chat unavailable');
              await deps.createLoop!(
                ordered.sessionId,
                await workspaceRootFor(meta, ordered.sessionId),
              ).run(ordered.sessionId, ordered.prompt, sinkFor(ordered.sessionId), {
                signal,
                actor: ordered.actor,
                tenantId: ordered.tenantId,
                policy: ordered.policy,
                promptSeq: ordered.promptSeq,
                cancellationSeq: ordered.cancellationSeq,
                contextGuard: executionGuard(ordered.sessionId, ordered.actor),
                content: ordered.content,
              });
            },
            signal,
          ),
        );
      if (tasks.length < 100) break;
      cursor = tasks.at(-1)!.sessionId;
    }
  });
  app.addHook('onClose', async () => {
    for (const controllers of inlineTurns.values())
      for (const controller of controllers) controller.abort();
    await Promise.allSettled([...inlineJobs]);
  });
  const cancelTurn = async (
    sessionId: string,
    actor: string,
  ): Promise<{ ok: true; alreadyStopped: boolean }> => {
    const history = await deps.store.load(sessionId);
    let promptSeq = 0;
    let terminalSeq = 0;
    history.forEach((event, index) => {
      if (event.type === 'message/user' || event.type === 'prompt/queued') promptSeq = index + 1;
      if (event.type === 'turn/end') terminalSeq = index + 1;
    });
    if (promptSeq > 0)
      await deps.store.append(
        sessionId,
        [
          {
            type: 'turn/cancel_requested',
            eventId: newId(),
            at: new Date().toISOString(),
            throughPromptSeq: promptSeq,
          },
        ],
        { actor },
      );
    const discarded = history.filter(
      (event) =>
        event.type === 'prompt/queued' &&
        !history.some(
          (item) =>
            (item.type === 'message/user' && item.eventId === event.promptId) ||
            (item.type === 'prompt/discarded' && item.promptId === event.promptId),
        ),
    );
    if (discarded.length)
      await deps.store.append(
        sessionId,
        discarded.map((event) => ({
          type: 'prompt/discarded' as const,
          eventId: newId(),
          at: new Date().toISOString(),
          promptId: event.type === 'prompt/queued' ? event.promptId : event.eventId,
          reason: 'cancelled' as const,
        })),
        { actor },
      );
    for (const controller of inlineTurns.get(sessionId) ?? []) controller.abort();
    await deps.turns?.cancel(sessionId);
    return { ok: true, alreadyStopped: promptSeq === 0 || terminalSeq > promptSeq };
  };

  /** Ownership check (fail-closed, design.md §12): 404 hides existence. */
  const authorizeSession = async (
    sessionId: string,
    identity: Identity | undefined,
    reply: FastifyReply,
  ): Promise<{ sessionId: string; meta: SessionMeta | null } | null> => {
    if (!auth) {
      return { sessionId, meta: null };
    }
    const meta = await auth.metas.get(sessionId);
    const ownOrAdmin = meta && identity && canAccess(identity, meta);
    const teamMember =
      !ownOrAdmin &&
      meta &&
      identity &&
      meta.tenantId === identity.tenantId &&
      meta.scope === 'team' &&
      meta.scopeId &&
      deps.teams &&
      (await deps.teams.isMember(meta.scopeId, identity.userId));
    if (!meta || meta.closedAt || !identity || (!ownOrAdmin && !teamMember)) {
      emitAudit({
        id: newId(),
        at: new Date().toISOString(),
        tenantId: identity?.tenantId ?? NIL_TENANT,
        userId: identity?.userId ?? 'anonymous',
        sessionId,
        action: 'session/access',
        result: 'denied',
      });
      await reply.code(404).send({ error: 'session not found' });
      return null;
    }
    if (
      meta.scope === 'team' &&
      (!meta.scopeId || !deps.teams || !(await deps.teams.isMember(meta.scopeId, identity.userId)))
    ) {
      await reply.code(404).send({ error: 'session not found' });
      return null;
    }
    return { sessionId, meta };
  };

  const executionGuard = (sessionId: string, actor: string): (() => Promise<void>) | undefined =>
    !auth
      ? undefined
      : async () => {
          const meta = await auth.metas.get(sessionId);
          const user = await auth.users.findById(actor);
          if (
            !meta ||
            meta.closedAt ||
            !user ||
            user.tenantId !== meta.tenantId ||
            user.role === 'viewer'
          )
            throw new Error('Execution access revoked');
          if (
            meta.scope === 'team' &&
            (!meta.scopeId || !deps.teams || !(await deps.teams.isMember(meta.scopeId, actor)))
          )
            throw new Error('Team access revoked');
          if (meta.scope !== 'team' && meta.userId !== actor && user.role !== 'admin')
            throw new Error('Session access revoked');
          await deps.schedules?.assertRunAuthorized(sessionId, actor);
        };

  /** Path-param validation for :sessionId routes (400 on malformed uuid). */
  const sessionIdOf = async (req: FastifyRequest, reply: FastifyReply): Promise<string | null> => {
    const params = postParamsSchema.safeParse(req.params);
    if (!params.success) {
      await reply.code(400).send({ error: 'invalid session id' });
      return null;
    }
    return params.data.sessionId;
  };

  /** M3: effective policy for a session (meta row wins; fail-closed default). */
  const policyFor = (meta: SessionMeta | null): PermissionPolicy => {
    if (meta?.policy !== undefined && meta.policy !== null) {
      return parsePermissionPolicy(meta.policy);
    }
    return deps.defaultPolicy ?? parsePermissionPolicy('workspace-write');
  };

  /**
   * Sandbox root for a session: the directory bound at creation
   * (automatic Chat storage or a selected personal/team workspace).
   * Legacy Chat is bound durably; meta-less Chat uses its creation receipt.
   */
  const workspaceRootFor = async (
    meta: SessionMeta | null | undefined,
    sessionId: string,
  ): Promise<string> => {
    if (meta) return sessionWorkspaceRoot(meta, deps.workspaceRoot, auth?.metas);
    const creation = (await deps.store.loadRange(sessionId, { afterSeq: 0, toSeq: 1 }))[0]?.event;
    if (creation?.type === 'session/created' && creation.kind === 'chat') {
      if (!creation.workspaceUri) throw new Error('Chat workspace unavailable');
      return creation.workspaceUri;
    }
    return deps.workspaceRoot;
  };

  const enqueueMain = async (
    meta: SessionMeta,
    identity: Identity,
    text: string,
    content: ContentBlock[],
  ): Promise<{ promptId: string; afterSeq: number }> => {
    if (!deps.sessionRuns || (!deps.queue && !deps.createLoop))
      throw new Error('No main chat runner configured');
    const promptId = newId();
    const source = await deps.store.append(
      meta.id,
      [
        {
          type: 'prompt/queued',
          eventId: newId(),
          promptId,
          at: new Date().toISOString(),
          content,
          actor: identity.userId,
          tenantId: identity.tenantId,
          policy: policyFor(meta),
        },
      ],
      { actor: identity.userId },
    );
    const task: TurnTask = {
      sessionId: meta.id,
      prompt: text,
      content,
      actor: identity.userId,
      tenantId: identity.tenantId,
      policy: policyFor(meta),
      promptSeq: source.from,
    };
    if (deps.queue) {
      try {
        await deps.queue.enqueue(task);
      } catch {
        app.log.warn('Main chat request committed; durable dispatcher will retry delivery');
      }
    } else
      runInline(meta.id, (signal) =>
        runOrderedPrompts(
          deps.sessionRuns!,
          deps.store,
          task,
          async (ordered) => {
            await deps.createLoop!(meta.id, await workspaceRootFor(meta, ordered.sessionId)).run(
              meta.id,
              ordered.prompt,
              sinkFor(meta.id),
              {
                signal,
                actor: ordered.actor,
                tenantId: ordered.tenantId,
                policy: ordered.policy,
                promptSeq: ordered.promptSeq,
                cancellationSeq: ordered.cancellationSeq,
                contextGuard: executionGuard(ordered.sessionId, ordered.actor),
                content: ordered.content,
              },
            );
          },
          signal,
        ),
      );
    return { promptId, afterSeq: source.from };
  };

  app.get('/api/health', async () => ({ ok: true }));

  // ---- Auth & admin (M2: 鉴权/租户/RBAC) ------------------------------------

  if (auth) {
    app.post('/api/auth/login', async (req, reply) => {
      const body = loginSchema.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
      }
      const user = await auth.users.verifyCredentials(body.data.email, body.data.password);
      if (!user) {
        emitAudit({
          id: newId(),
          at: new Date().toISOString(),
          tenantId: NIL_TENANT,
          userId: 'anonymous',
          action: 'auth/login',
          target: body.data.email,
          result: 'denied',
        });
        // Same response for unknown user / wrong password (no oracle).
        return reply.code(401).send({ error: 'invalid credentials' });
      }
      const token = await auth.tokens.issue({
        userId: user.id,
        tenantId: user.tenantId,
        role: user.role,
      });
      emitAudit({
        id: newId(),
        at: new Date().toISOString(),
        tenantId: user.tenantId,
        userId: user.id,
        action: 'auth/login',
        result: 'ok',
      });
      return { token, user };
    });

    app.get('/api/me', async (req, reply) => {
      const identity = req.identity!;
      const user = await auth.users.findById(identity.userId);
      if (!user) {
        return reply.code(404).send({ error: 'user not found' });
      }
      return { user };
    });

    app.post('/api/admin/users', async (req, reply) => {
      const identity = req.identity!;
      if (identity.role !== 'admin') {
        emitAudit({
          id: newId(),
          at: new Date().toISOString(),
          tenantId: identity.tenantId,
          userId: identity.userId,
          action: 'admin/user-create',
          result: 'denied',
        });
        return reply.code(403).send({ error: 'admin role required' });
      }
      const body = createUserSchema.safeParse(req.body);
      if (!body.success) {
        return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
      }
      const passwordHash = await auth.hasher.hash(body.data.password);
      const user = await auth.users.createUser({
        tenantId: identity.tenantId,
        email: body.data.email,
        passwordHash,
        role: body.data.role,
      });
      emitAudit({
        id: newId(),
        at: new Date().toISOString(),
        tenantId: identity.tenantId,
        userId: identity.userId,
        action: 'admin/user-create',
        target: user.email,
        result: 'ok',
      });
      return reply.code(201).send({ user });
    });

    app.get('/api/admin/users', async (req, reply) => {
      const identity = req.identity!;
      if (identity.role !== 'admin') {
        return reply.code(403).send({ error: 'admin role required' });
      }
      const users = await auth.users.listByTenant(identity.tenantId);
      return { users };
    });

    app.get('/api/sessions', async (req) => {
      const identity = req.identity!;
      const metas = await auth.metas.listForIdentity(identity);
      return {
        sessions: metas.map((m) => ({
          sessionId: m.id,
          userId: m.userId,
          title: m.title,
          createdAt: m.createdAt,
          workspaceUri: m.workspaceUri,
          kind: m.kind,
          sessionRole: m.sessionRole,
          taskState: m.taskState,
          originSessionId: m.originSessionId,
          scope: m.scope ?? 'personal',
          ...(m.scopeId !== undefined ? { scopeId: m.scopeId } : {}),
        })),
      };
    });

    // ---- Teams (shared workspaces, docs/design.md §15) -----------------------

    if (deps.teams) {
      app.get('/api/teams', async (req) => {
        const identity = req.identity!;
        const teams = await deps.teams!.listForUser(identity.userId);
        const withMembers = await Promise.all(
          teams.map(async (t) => ({
            teamId: t.id,
            name: t.name,
            createdAt: t.createdAt,
            members: await deps.teams!.listMembers(t.id),
          })),
        );
        return { teams: withMembers };
      });

      app.post('/api/teams', async (req, reply) => {
        const identity = req.identity!;
        if (identity.role === 'viewer') {
          return reply.code(403).send({ error: 'viewer role cannot create teams' });
        }
        const body = z.object({ name: z.string().min(1).max(200) }).safeParse(req.body);
        if (!body.success) {
          return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
        }
        const team = await deps.teams!.create({
          tenantId: identity.tenantId,
          name: body.data.name,
          ownerId: identity.userId,
        });
        emitAudit({
          id: newId(),
          at: new Date().toISOString(),
          tenantId: identity.tenantId,
          userId: identity.userId,
          action: 'team/created',
          target: team.name,
          result: 'ok',
        });
        return reply.code(201).send({ team });
      });

      const addMemberSchema = z.object({ email: z.string().email() });
      app.post('/api/teams/:teamId/members', async (req, reply) => {
        const identity = req.identity!;
        const teamId = (req.params as Record<string, string>)['teamId'] ?? '';
        const team = await deps.teams!.get(teamId);
        if (!team || team.tenantId !== identity.tenantId) {
          return reply.code(404).send({ error: 'team not found' });
        }
        // Only the team owner or a tenant admin may add members (fail-closed).
        const canManage =
          identity.role === 'admin' || (await deps.teams!.isOwner(teamId, identity.userId));
        if (!canManage) {
          return reply.code(403).send({ error: 'team owner or admin required' });
        }
        const body = addMemberSchema.safeParse(req.body);
        if (!body.success) {
          return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
        }
        const user = await auth.users.findByEmail(body.data.email);
        if (!user || user.tenantId !== identity.tenantId) {
          return reply.code(404).send({ error: 'user not found in this tenant' });
        }
        if (await deps.teams!.isMember(teamId, user.id)) {
          return reply.code(409).send({ error: 'already a member' });
        }
        await deps.teams!.addMember(teamId, user.id, 'member');
        emitAudit({
          id: newId(),
          at: new Date().toISOString(),
          tenantId: identity.tenantId,
          userId: identity.userId,
          action: 'team/member-add',
          target: team.name,
          result: 'ok',
          detail: { member: user.email },
        });
        return reply.code(201).send({ ok: true });
      });
    }

    if (deps.auditQuery) {
      app.get('/api/audit', async (req, reply) => {
        const identity = req.identity!;
        if (identity.role !== 'admin') {
          return reply.code(403).send({ error: 'admin role required' });
        }
        const query = auditQuerySchema.safeParse(req.query);
        if (!query.success) {
          return reply.code(400).send({ error: 'invalid query' });
        }
        const page = await deps.auditQuery!.query({
          tenantId: identity.tenantId,
          ...(query.data.sessionId !== undefined ? { sessionId: query.data.sessionId } : {}),
          ...(query.data.action !== undefined ? { action: query.data.action } : {}),
          ...(query.data.limit !== undefined ? { limit: query.data.limit } : {}),
          ...(query.data.offset !== undefined ? { offset: query.data.offset } : {}),
        });
        return { records: page.records, total: page.total };
      });
    }

    // ---- M5: usage & quota (docs/design.md §17) ------------------------------

    if (deps.usage) {
      /** Per-window token usage + configured limits for one tenant. */
      const usageSummary = async (tenantId: string) => {
        const now = new Date();
        const [quota, hour, day, month] = await Promise.all([
          deps.usage!.quotaOf(tenantId),
          deps.usage!.usageSince(tenantId, windowStart('hour', now)),
          deps.usage!.usageSince(tenantId, windowStart('day', now)),
          deps.usage!.usageSince(tenantId, windowStart('month', now)),
        ]);
        return {
          windows: {
            hour: { used: hour, limit: quota.hourlyTokens ?? null },
            day: { used: day, limit: quota.dailyTokens ?? null },
            month: { used: month, limit: quota.monthlyTokens ?? null },
          },
          quota,
        };
      };

      app.get('/api/usage', async (req) => {
        const identity = req.identity!;
        return usageSummary(identity.tenantId);
      });

      app.get('/api/admin/usage', async (req, reply) => {
        const identity = req.identity!;
        if (identity.role !== 'admin') {
          return reply.code(403).send({ error: 'admin role required' });
        }
        return usageSummary(identity.tenantId);
      });

      if (deps.quotaAdmin) {
        app.put('/api/admin/quota', async (req, reply) => {
          const identity = req.identity!;
          if (identity.role !== 'admin') {
            emitAudit({
              id: newId(),
              at: new Date().toISOString(),
              tenantId: identity.tenantId,
              userId: identity.userId,
              action: 'tenant/quota',
              result: 'denied',
            });
            return reply.code(403).send({ error: 'admin role required' });
          }
          const body = tenantQuotaSchema.safeParse(req.body ?? {});
          if (!body.success) {
            return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
          }
          await deps.quotaAdmin!.setQuota(identity.tenantId, body.data);
          emitAudit({
            id: newId(),
            at: new Date().toISOString(),
            tenantId: identity.tenantId,
            userId: identity.userId,
            action: 'tenant/quota',
            result: 'ok',
            detail: body.data,
          });
          return { ok: true, quota: body.data };
        });
      }
    }
  }

  app.get('/api/memory', async (req, reply) => {
    if (!req.identity || !deps.memory)
      return reply.code(503).send({ error: 'Durable memory unavailable' });
    return deps.memory.snapshot(req.identity);
  });
  app.post('/api/memory', async (req, reply) => {
    if (!req.identity || !deps.memory)
      return reply.code(503).send({ error: 'Durable memory unavailable' });
    if (req.identity.role === 'viewer') return reply.code(403).send({ error: 'read-only' });
    const parsed = memoryCommandSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid memory command' });
    try {
      validateMemoryCommand(parsed.data);
      if (parsed.data.source) {
        const source = await auth?.metas.get(parsed.data.source.sessionId);
        if (
          !source ||
          source.tenantId !== req.identity.tenantId ||
          source.userId !== req.identity.userId ||
          source.scope === 'team' ||
          source.closedAt
        )
          return reply.code(403).send({ error: 'invalid personal source' });
        const events = await deps.store.load(parsed.data.source.sessionId);
        const event = events.find((item) => item.eventId === parsed.data.source!.eventId);
        if (
          !event ||
          event.type !== 'message/user' ||
          (parsed.data.source.at !== undefined && parsed.data.source.at !== event.at) ||
          !blocksToText(event.content).includes(parsed.data.source.excerpt)
        )
          return reply.code(400).send({ error: 'source excerpt not found' });
      }
      const item = await deps.memory.change(req.identity, parsed.data);
      return { item };
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'MEMORY_CONFLICT')
        return reply.code(409).send({ error: 'Memory changed; refresh and retry.' });
      if (code === 'MEMORY_SECRET')
        return reply.code(400).send({ error: 'Use secret storage for credentials.' });
      throw error;
    }
  });
  app.get('/api/history', async (req, reply) => {
    if (!req.identity || !deps.conversationIndex)
      return reply.code(503).send({ error: 'History index unavailable' });
    const query = historyQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid history query' });
    try {
      new Intl.DateTimeFormat('en', { timeZone: query.data.timezone });
    } catch {
      return reply.code(400).send({ error: 'invalid timezone' });
    }
    return deps.conversationIndex.history(req.identity, query.data);
  });
  app.patch('/api/history/:episodeId', async (req, reply) => {
    if (!req.identity || !deps.conversationIndex)
      return reply.code(503).send({ error: 'History index unavailable' });
    if (req.identity.role === 'viewer') return reply.code(403).send({ error: 'read-only' });
    const id = z.object({ episodeId: z.uuid() }).safeParse(req.params);
    const body = z
      .object({ topic: z.string().min(1).max(200).optional(), excluded: z.boolean().optional() })
      .strict()
      .safeParse(req.body);
    if (!id.success || !body.success)
      return reply.code(400).send({ error: 'invalid history update' });
    await deps.conversationIndex.revise(req.identity, id.data.episodeId, body.data);
    return { ok: true };
  });
  app.get('/api/sessions/:sessionId/memory', async (req, reply) => {
    const id = await sessionIdOf(req, reply);
    if (!id || !(await authorizeSession(id, req.identity, reply))) return;
    const events = deps.store.loadPage
      ? (await deps.store.loadPage(id, { limit: 300 })).entries.map((entry) => entry.event)
      : await deps.store.load(id);
    return { selections: events.filter((event) => event.type === 'memory/selection').slice(-20) };
  });

  app.get('/api/main-chat', async (req, reply) => {
    if (!auth || !req.identity) return reply.code(401).send({ error: 'authentication required' });
    const meta = await auth.metas.getMain?.(req.identity.tenantId, req.identity.userId);
    return { sessionId: meta?.id ?? null };
  });

  // ---- Sessions --------------------------------------------------------------

  app.get('/api/workspaces/personal', async (req, reply) => {
    if (!req.identity) return reply.code(401).send({ error: 'unauthorized' });
    const query = personalFoldersQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid folder path' });
    try {
      const folders = await listPersonalFolders(
        deps.workspaceRoot,
        req.identity.userId,
        query.data.path ?? '',
      );
      return { folders };
    } catch {
      return reply.code(400).send({ error: 'invalid folder path' });
    }
  });

  app.post('/api/sessions', async (req, reply) => {
    const body = createSessionSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
    }
    // Validate the policy at the boundary (fail-closed, AGENTS.md §5); the
    // preset NAME is persisted, keeping rows human-readable.
    let policyName: string | undefined;
    if (body.data.policy !== undefined) {
      try {
        policyName = body.data.policy;
        parsePermissionPolicy(policyName);
      } catch {
        return reply.code(400).send({ error: 'invalid permission policy' });
      }
    }
    let sessionId = newId();
    const identity = req.identity;
    const kind = body.data.kind;
    const sessionRole =
      body.data.sessionRole ?? (kind === 'chat' ? 'side' : kind === 'work' ? 'task' : undefined);
    if (identity?.role === 'viewer' && kind)
      return reply.code(403).send({ error: 'viewer role is read-only' });
    if (
      (kind === 'chat' && (body.data.workspace || sessionRole === 'task')) ||
      (kind === 'work' && (!body.data.workspace || sessionRole !== 'task')) ||
      (!kind && sessionRole) ||
      (sessionRole === 'main' && kind !== 'chat')
    )
      return reply.code(400).send({ error: 'invalid session kind, role or workspace' });
    if (
      body.data.originSessionId &&
      !(await authorizeSession(body.data.originSessionId, identity, reply))
    )
      return;
    const operationId = body.data.creationOperationId;
    let existing =
      identity && auth && operationId
        ? await auth.metas.findByOperation?.(identity.tenantId, identity.userId, operationId)
        : null;
    if (!existing && identity && auth && sessionRole === 'main')
      existing = await auth.metas.getMain?.(identity.tenantId, identity.userId);
    if (existing) {
      if (existing.closedAt)
        return reply.code(409).send({ error: 'creation operation belongs to a closed session' });
      sessionId = existing.id;
      await deps.store.append(
        sessionId,
        [
          {
            type: 'session/created',
            eventId: newId(),
            at: existing.createdAt,
            workspaceUri: existing.workspaceUri,
            kind: existing.kind,
            sessionRole: existing.sessionRole,
            creationOperationId: existing.creationOperationId,
            originSessionId: existing.originSessionId,
          },
        ],
        { actor: identity?.userId ?? 'anonymous' },
      );
      return reply.code(201).send({ sessionId });
    }

    // Workspace scope: personal or team (fail-closed membership check, §12).
    const ws = body.data.workspace;
    const scope = ws?.scope ?? 'personal';
    // Memory mode (no auth) has no user directory: everything lands in one
    // shared fallback directory.
    const scopeOwnerId = identity?.userId ?? 'anonymous';
    let scopeId: string | undefined;
    if (scope === 'team') {
      const teamId = ws?.scope === 'team' ? ws.teamId : undefined;
      if (!teamId || !deps.teams || !identity) {
        return reply.code(400).send({ error: 'team workspace requires a teamId' });
      }
      const team = await deps.teams.get(teamId);
      // Fail-closed: unknown team, other tenant, or non-member ⇒ denied.
      if (!team || team.tenantId !== identity.tenantId) {
        return reply.code(403).send({ error: 'not a member of this team' });
      }
      const member = await deps.teams.isMember(teamId, identity.userId);
      if (!member) {
        emitAudit({
          id: newId(),
          at: new Date().toISOString(),
          tenantId: identity.tenantId,
          userId: identity.userId,
          action: 'session/created',
          target: `team:${teamId}`,
          result: 'denied',
        });
        return reply.code(403).send({ error: 'not a member of this team' });
      }
      scopeId = team.id;
    }
    let workspaceDir: string | null;
    if (kind === 'chat') {
      workspaceDir = await chatWorkspaceDir(deps.workspaceRoot, scopeOwnerId, sessionId);
    } else if (scope === 'personal' && identity) {
      try {
        workspaceDir = await personalWorkspaceDir(
          deps.workspaceRoot,
          identity.userId,
          ws?.scope === 'personal' ? (ws.path ?? '') : '',
        );
      } catch {
        return reply.code(400).send({ error: 'invalid personal workspace folder' });
      }
    } else {
      workspaceDir = workspaceDirFor(deps.workspaceRoot, scope, scopeId ?? scopeOwnerId);
      // The sandbox root must exist before tools run against it.
      await mkdir(workspaceDir, { recursive: true });
    }

    if (auth && !existing) {
      // Ownership row first; the event log references it by id.
      try {
        await auth.metas.create({
          kind,
          sessionRole,
          creationOperationId: operationId,
          originSessionId: body.data.originSessionId,
          id: sessionId,
          tenantId: identity!.tenantId,
          userId: identity!.userId,
          title: body.data.title ?? '',
          workspaceUri: workspaceDir,
          scope,
          ...(scopeId !== undefined ? { scopeId } : {}),
          ...(policyName !== undefined ? { policy: policyName } : {}),
        });
      } catch (error) {
        existing =
          identity && operationId
            ? await auth.metas.findByOperation?.(identity.tenantId, identity.userId, operationId)
            : null;
        if (!existing && identity && sessionRole === 'main')
          existing = await auth.metas.getMain?.(identity.tenantId, identity.userId);
        if (!existing) throw error;
        sessionId = existing.id;
      }
    }
    await deps.store.append(
      sessionId,
      [
        {
          type: 'session/created',
          eventId: newId(),
          at: new Date().toISOString(),
          workspaceUri: existing ? existing.workspaceUri : workspaceDir,
          kind: existing ? existing.kind : kind,
          sessionRole: existing ? existing.sessionRole : sessionRole,
          creationOperationId: existing ? existing.creationOperationId : operationId,
          originSessionId: existing ? existing.originSessionId : body.data.originSessionId,
        },
      ],
      { actor: identity?.userId ?? 'anonymous' },
    );
    emitAudit({
      id: newId(),
      at: new Date().toISOString(),
      tenantId: identity?.tenantId ?? NIL_TENANT,
      userId: identity?.userId ?? 'anonymous',
      sessionId,
      action: 'session/created',
      ...(body.data.title !== undefined ? { target: body.data.title } : {}),
      result: 'ok',
    });
    return reply.code(201).send({ sessionId });
  });

  app.post('/api/sessions/:sessionId/share-back', async (req, reply) => {
    const id = await sessionIdOf(req, reply);
    if (!id) return;
    const granted = await authorizeSession(id, req.identity, reply);
    if (!granted || !auth || !req.identity) return;
    if (req.identity.role === 'viewer') return reply.code(403).send({ error: 'read-only' });
    const body = z.object({ eventId: z.uuid() }).strict().safeParse(req.body);
    if (!body.success)
      return reply.code(400).send({ error: 'Select a completed answer to share.' });
    const main = await auth.metas.getMain?.(req.identity.tenantId, req.identity.userId);
    if (!main || main.id === id || main.closedAt)
      return reply.code(409).send({ error: 'Main chat is unavailable.' });
    const events = await deps.store.load(id);
    const source = events.findIndex(
      (event) => event.eventId === body.data.eventId && event.type === 'message/assistant',
    );
    if (source < 0 || !turnMessageProjection(events).finals.has(source))
      return reply.code(400).send({ error: 'Only completed final answers can be shared.' });
    await deps.store.append(
      main.id,
      [
        {
          type: 'activity/reference',
          eventId: newId(),
          at: new Date().toISOString(),
          sourceSessionId: id,
          sourceEventId: body.data.eventId,
          kind: granted.meta?.kind === 'work' ? 'work' : 'chat',
        },
      ],
      { actor: req.identity.userId },
    );
    broadcast(main.id, {
      type: 'session/activity',
      sessionId: main.id,
      sourceSessionId: id,
      sourceEventId: body.data.eventId,
      kind: granted.meta?.kind === 'work' ? 'work' : 'chat',
    });
    return { ok: true };
  });

  app.get('/api/sessions/:sessionId/timeline', async (req, reply) => {
    const id = await sessionIdOf(req, reply);
    if (!id || !(await authorizeSession(id, req.identity, reply))) return;
    const query = z
      .object({ beforeSeq: z.coerce.number().int().positive().optional() })
      .safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'invalid cursor' });
    if (!deps.store.loadPage) return reply.code(503).send({ error: 'Bounded paging unavailable' });
    const page = await deps.store.loadPage(id, { ...query.data, limit: 200 });
    return {
      events: page.entries
        .map(({ event }) => logEventToServerEvent(id, event))
        .filter((event) => event !== null),
      nextBefore: page.nextBefore,
      lastSeq: page.lastSeq,
    };
  });

  app.get('/api/sessions/:sessionId/messages', async (req, reply) => {
    const sessionId = await sessionIdOf(req, reply);
    if (!sessionId) return;
    const granted = await authorizeSession(sessionId, req.identity, reply);
    if (!granted) return;
    const surface = await deps.store.projectMessages(granted.sessionId);
    return {
      messages: surface.map((m) => ({
        role: m.role,
        content: blocksToText(m.content),
        ...(m.citationList ? { citationList: m.citationList } : {}),
      })),
    };
  });

  app.get('/api/sessions/:sessionId/export', async (req, reply) => {
    const sessionId = await sessionIdOf(req, reply);
    if (!sessionId) return;
    const granted = await authorizeSession(sessionId, req.identity, reply);
    if (!granted) return;
    const messages = await deps.store.projectMessages(granted.sessionId);
    reply.header('content-disposition', `attachment; filename="session-${sessionId}.json"`);
    reply.header('cache-control', 'no-store');
    return {
      sessionId,
      title: granted.meta?.title ?? '',
      createdAt: granted.meta?.createdAt ?? null,
      usage: (await deps.store.load(granted.sessionId))
        .filter((event) => event.type === 'model/usage')
        .map((event) => event.usage),
      messages,
    };
  });

  app.delete('/api/sessions/:sessionId', async (req, reply) => {
    const sessionId = await sessionIdOf(req, reply);
    if (!sessionId) return;
    const granted = await authorizeSession(sessionId, req.identity, reply);
    if (!granted) return;
    const identity = req.identity;
    if (
      !auth ||
      !identity ||
      identity.role === 'viewer' ||
      !granted.meta ||
      !canAccess(identity, granted.meta)
    ) {
      return reply.code(403).send({ error: 'session deletion requires a developer or admin' });
    }
    if (granted.meta.sessionRole === 'main')
      return reply
        .code(409)
        .send({ error: 'Main chat remains ongoing; manage topics in History.' });
    await cancelTurn(sessionId, identity?.userId ?? 'anonymous');
    await deps.store.append(
      sessionId,
      [{ type: 'session/closed', eventId: newId(), at: new Date().toISOString() }],
      { actor: identity.userId },
    );
    await auth.metas.close(sessionId);
    emitAudit({
      id: newId(),
      at: new Date().toISOString(),
      tenantId: identity.tenantId,
      userId: identity.userId,
      sessionId,
      action: 'session/closed',
      result: 'ok',
    });
    return reply.code(204).send();
  });

  app.post('/api/sessions/:sessionId/messages', async (req, reply) => {
    const sessionId = await sessionIdOf(req, reply);
    if (!sessionId) return;
    const granted = await authorizeSession(sessionId, req.identity, reply);
    if (!granted) return;
    const body = postMessageSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid request' });
    }
    const identity = req.identity;
    if (identity?.role === 'viewer') {
      emitAudit({
        id: newId(),
        at: new Date().toISOString(),
        tenantId: identity.tenantId,
        userId: identity.userId,
        sessionId: granted.sessionId,
        action: 'session/prompt',
        result: 'denied',
      });
      return reply.code(403).send({ error: 'viewer role is read-only' });
    }
    if (credentialMemoryRequest(body.data.text))
      return reply.code(400).send({ error: 'Credentials cannot be stored in personal memory.' });
    await auth?.metas.setTitleIfEmpty(sessionId, body.data.text.trim().slice(0, 200));
    emitAudit({
      id: newId(),
      at: new Date().toISOString(),
      tenantId: identity?.tenantId ?? NIL_TENANT,
      userId: identity?.userId ?? 'anonymous',
      sessionId: granted.sessionId,
      action: 'session/prompt',
      result: 'ok',
    });

    if (granted.meta?.sessionRole === 'main' && deps.sessionRuns) {
      await enqueueMain(
        granted.meta,
        identity!,
        body.data.text,
        promptContent(body.data.text, body.data.attachments),
      );
      return reply.code(202).send({ accepted: true, queued: true });
    }

    if (deps.queue) {
      // M3: the user message is committed HERE (server-side, actor-stamped)
      // so the turn task carries its exact seq (promptSeq) for the
      // permission-gated prompt path (docs/design.md §11.3, §12).
      const appended = await deps.store.append(
        granted.sessionId,
        [
          {
            type: 'message/user',
            eventId: newId(),
            at: new Date().toISOString(),
            surfaceOp: 'append',
            content: promptContent(body.data.text, body.data.attachments),
          },
        ],
        { actor: identity?.userId ?? 'anonymous' },
      );
      await deps.queue.enqueue({
        sessionId: granted.sessionId,
        prompt: body.data.text,
        ...(body.data.attachments !== undefined
          ? { content: promptContent(body.data.text, body.data.attachments) }
          : {}),
        actor: identity?.userId ?? 'anonymous',
        tenantId: identity?.tenantId ?? granted.meta?.tenantId ?? NIL_TENANT,
        promptSeq: appended.from,
        policy: policyFor(granted.meta),
      });
      return reply.code(202).send({ accepted: true });
    }

    if (!deps.createLoop) {
      return reply.code(503).send({ error: 'no agent runner configured' });
    }
    const appended = await deps.store.append(
      sessionId,
      [
        {
          type: 'message/user',
          eventId: newId(),
          at: new Date().toISOString(),
          surfaceOp: 'append',
          content: promptContent(body.data.text, body.data.attachments),
        },
      ],
      { actor: identity?.userId ?? 'anonymous' },
    );
    const sink = sinkFor(sessionId);
    const loop = deps.createLoop(sessionId, await workspaceRootFor(granted.meta, sessionId));
    runInline(sessionId, (signal) =>
      loop.run(sessionId, body.data.text, sink, {
        signal,
        actor: identity?.userId ?? 'anonymous',
        contextGuard: executionGuard(sessionId, identity?.userId ?? 'anonymous'),
        tenantId: identity?.tenantId,
        policy: policyFor(granted.meta),
        promptSeq: appended.from,
        ...(body.data.attachments !== undefined
          ? { content: promptContent(body.data.text, body.data.attachments) }
          : {}),
      }),
    );
    return reply.code(202).send({ accepted: true });
  });

  app.get('/api/sessions/:sessionId/browser-preview', async (req, reply) => {
    const sessionId = await sessionIdOf(req, reply);
    if (!sessionId) return;
    const granted = await authorizeSession(sessionId, req.identity, reply);
    if (!granted) return;
    // Live private pixels require the actual personal owner, not tenant admin or team access.
    if (
      auth &&
      (!granted.meta ||
        granted.meta.scope === 'team' ||
        granted.meta.userId !== req.identity?.userId)
    )
      return reply.code(404).send({ error: 'browser unavailable' });
    reply.header('cache-control', 'private, no-store').header('x-content-type-options', 'nosniff');
    if (!deps.browserPreview) return { state: 'unavailable' };
    const cancelled = new AbortController();
    const abort = (): void => {
      if (!reply.raw.writableFinished) cancelled.abort();
    };
    req.raw.once('aborted', abort);
    reply.raw.once('close', abort);
    try {
      const result = await deps.browserPreview.preview(sessionId, cancelled.signal);
      if (!(await authorizeSession(sessionId, req.identity, reply))) return;
      return browserPreviewSchema.parse(result);
    } catch {
      return reply.code(503).send({ error: 'browser preview unavailable' });
    } finally {
      req.raw.removeListener('aborted', abort);
      reply.raw.removeListener('close', abort);
    }
  });
  app.post(
    '/api/sessions/:sessionId/browser-interaction',
    { bodyLimit: 24 * 1024 },
    async (req, reply) => {
      const sessionId = await sessionIdOf(req, reply);
      if (!sessionId) return;
      const granted = await authorizeSession(sessionId, req.identity, reply);
      if (!granted) return;
      if (
        auth &&
        (!granted.meta ||
          granted.meta.scope === 'team' ||
          granted.meta.closedAt ||
          granted.meta.userId !== req.identity?.userId)
      )
        return reply.code(404).send({ error: 'browser unavailable' });
      if (!deps.browserInteraction)
        return reply.code(501).send({ error: 'browser interaction is not configured' });
      const body =
        req.body && typeof req.body === 'object' && !Array.isArray(req.body)
          ? (req.body as Record<string, unknown>)
          : {};
      if ('sessionId' in body)
        return reply.code(400).send({ error: 'invalid browser interaction' });
      const parsed = browserInteractionRequestSchema.safeParse({ ...body, sessionId });
      if (!parsed.success) return reply.code(400).send({ error: 'invalid browser interaction' });
      const cancelled = new AbortController();
      const abort = (): void => {
        if (!reply.raw.writableFinished) cancelled.abort();
      };
      req.raw.once('aborted', abort);
      reply.raw.once('close', abort);
      try {
        const result = await deps.browserInteraction.interact(parsed.data, cancelled.signal);
        const current = await authorizeSession(sessionId, req.identity, reply);
        if (!current) return;
        if (
          auth &&
          (current.meta?.scope === 'team' ||
            current.meta?.closedAt ||
            current.meta?.userId !== req.identity?.userId)
        )
          return reply.code(404).send({ error: 'browser unavailable' });
        return reply
          .header('cache-control', 'private, no-store')
          .header('x-content-type-options', 'nosniff')
          .send(browserInteractionResultSchema.parse(result));
      } catch {
        return reply.code(503).send({ error: 'browser interaction unavailable' });
      } finally {
        req.raw.removeListener('aborted', abort);
        reply.raw.removeListener('close', abort);
      }
    },
  );

  // ---- M4: attachments & blob storage (docs/design.md §10) ------------------

  if (deps.blobs) {
    app.get('/api/sessions/:sessionId/browser-images/:observationId', async (req, reply) => {
      const sessionId = await sessionIdOf(req, reply);
      if (!sessionId) return;
      const granted = await authorizeSession(sessionId, req.identity, reply);
      if (!granted) return;
      const observationId = (req.params as Record<string, string>)['observationId'] ?? '';
      if (!/^[A-Za-z0-9_-]{1,200}$/.test(observationId))
        return reply.code(400).send({ error: 'invalid observation' });
      const uri = `blob://browser/${encodeURIComponent(sessionId)}/${observationId}.png`;
      try {
        const bytes = await resolveBrowserImage(
          deps.blobs!,
          await deps.store.load(sessionId),
          sessionId,
          uri,
          false,
        );
        return reply
          .header('content-type', 'image/png')
          .header('cache-control', 'private, no-store')
          .header('x-content-type-options', 'nosniff')
          .send(Buffer.from(bytes));
      } catch {
        return reply.code(404).send({ error: 'authorized screenshot unavailable' });
      }
    });
    // Raw binary upload (application/octet-stream body); the attachment MIME
    // type travels in the query string so no multipart parser is needed.
    app.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: MAX_ATTACHMENT_BYTES },
      (_req, body, done) => done(null, body),
    );

    app.post(
      '/api/sessions/:sessionId/attachments',
      { bodyLimit: MAX_ATTACHMENT_BYTES },
      async (req, reply) => {
        const sessionId = await sessionIdOf(req, reply);
        if (!sessionId) return;
        const granted = await authorizeSession(sessionId, req.identity, reply);
        if (!granted) return;
        const identity = req.identity;
        if (identity?.role === 'viewer') {
          return reply.code(403).send({ error: 'viewer role is read-only' });
        }
        const query = z
          .object({
            mime: z.string().min(1).max(100),
            filename: z.string().min(1).max(200).optional(),
          })
          .safeParse(req.query);
        if (!query.success || !ATTACHMENT_MIME_ALLOWLIST.includes(query.data.mime)) {
          return reply
            .code(400)
            .send({ error: `mime must be one of: ${ATTACHMENT_MIME_ALLOWLIST.join(', ')}` });
        }
        const data = req.body;
        if (!Buffer.isBuffer(data) || data.byteLength === 0) {
          return reply.code(400).send({ error: 'binary body required (application/octet-stream)' });
        }
        const blob = await deps.blobs!.put(undefined, new Uint8Array(data), {
          mimeType: query.data.mime,
        });
        const workspacePath = await saveWorkspaceAttachment(
          await workspaceRootFor(granted.meta, sessionId),
          new Uint8Array(data),
          query.data.filename,
          deps.workspaceSandbox?.(sessionId, await workspaceRootFor(granted.meta, sessionId)),
        );
        await deps.store.append(
          sessionId,
          [
            {
              type: 'session/attachment',
              eventId: newId(),
              at: new Date().toISOString(),
              uri: blob.uri,
              workspacePath,
              mimeType: query.data.mime,
              size: data.byteLength,
            },
          ],
          { actor: identity?.userId ?? 'anonymous' },
        );
        emitAudit({
          id: newId(),
          at: new Date().toISOString(),
          tenantId: identity?.tenantId ?? NIL_TENANT,
          userId: identity?.userId ?? 'anonymous',
          sessionId: granted.sessionId,
          action: 'session/attachment',
          target: blob.uri,
          result: 'ok',
          detail: { mimeType: query.data.mime, size: data.byteLength },
        });
        return reply
          .code(201)
          .send({ uri: blob.uri, mimeType: query.data.mime, size: data.byteLength, workspacePath });
      },
    );

    // Blob download (UI image rendering, spill retrieval). Keys are
    // unguessable UUIDs; ownership hardening (per-session ACL) is M5+.
    app.get('/api/blobs/*', async (req, reply) => {
      const key = (req.params as Record<string, string>)['*'] ?? '';
      if (!key || key.includes('..') || key.includes('\\')) {
        return reply.code(400).send({ error: 'invalid blob key' });
      }
      if (key.split('/').includes('model-context'))
        return reply
          .code(403)
          .send({ error: 'model context snapshots are private runtime artifacts' });
      if (key.split('/').includes('browser')) {
        return reply
          .code(403)
          .send({ error: 'browser observations require authorized bounded saved reads' });
      }
      const meta = await deps.blobs!.getMeta(`blob://${key}`);
      const data = meta ? await deps.blobs!.get(meta.uri) : null;
      if (!meta || !data) {
        return reply.code(404).send({ error: 'blob not found' });
      }
      return reply
        .header('content-type', meta.mimeType)
        .header('cache-control', 'private, max-age=3600')
        .send(Buffer.from(data));
    });
  }

  // ---- M3: approvals, policy, cancel (REST control surface, design.md §11.1)

  app.get('/api/sessions/:sessionId/approvals', async (req, reply) => {
    const sessionId = await sessionIdOf(req, reply);
    if (!sessionId) return;
    const granted = await authorizeSession(sessionId, req.identity, reply);
    if (!granted) return;
    if (!deps.approvalStore) {
      return reply.code(503).send({ error: 'approval store not configured' });
    }
    const records = await deps.approvalStore.list(granted.sessionId);
    return { approvals: records };
  });

  app.post('/api/sessions/:sessionId/policy', async (req, reply) => {
    const sessionId = await sessionIdOf(req, reply);
    if (!sessionId) return;
    const granted = await authorizeSession(sessionId, req.identity, reply);
    if (!granted) return;
    const identity = req.identity;
    if (identity?.role === 'viewer') {
      return reply.code(403).send({ error: 'viewer role is read-only' });
    }
    const body = setPolicySchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
    }
    let parsed: PermissionPolicy;
    try {
      parsed = parsePermissionPolicy(body.data.policy);
    } catch {
      return reply.code(400).send({ error: 'invalid permission policy' });
    }
    if (auth) {
      await auth.metas.setPolicy(granted.sessionId, body.data.policy);
    }
    emitAudit({
      id: newId(),
      at: new Date().toISOString(),
      tenantId: identity?.tenantId ?? NIL_TENANT,
      userId: identity?.userId ?? 'anonymous',
      sessionId: granted.sessionId,
      action: 'session/policy',
      target: body.data.policy.slice(0, 100),
      result: 'ok',
      detail: { policy: parsed },
    });
    return { ok: true };
  });

  app.post('/api/sessions/:sessionId/cancel', async (req, reply) => {
    const sessionId = await sessionIdOf(req, reply);
    if (!sessionId) return;
    const granted = await authorizeSession(sessionId, req.identity, reply);
    if (!granted) return;
    const identity = req.identity;
    if (identity?.role === 'viewer') {
      return reply.code(403).send({ error: 'viewer role is read-only' });
    }
    const cancellation = await cancelTurn(granted.sessionId, identity?.userId ?? 'anonymous');
    emitAudit({
      id: newId(),
      at: new Date().toISOString(),
      tenantId: identity?.tenantId ?? NIL_TENANT,
      userId: identity?.userId ?? 'anonymous',
      sessionId: granted.sessionId,
      action: 'session/cancel',
      result: 'ok',
    });
    return cancellation;
  });

  app.post('/api/sessions/:sessionId/approvals/:approvalId/respond', async (req, reply) => {
    const sessionId = await sessionIdOf(req, reply);
    if (!sessionId) return;
    const approvalParams = z
      .object({ approvalId: z.uuid() })
      .safeParse({ approvalId: (req.params as Record<string, unknown>)['approvalId'] });
    if (!approvalParams.success) {
      return reply.code(400).send({ error: 'invalid approval id' });
    }
    const granted = await authorizeSession(sessionId, req.identity, reply);
    if (!granted) return;
    const identity = req.identity;
    if (identity?.role === 'viewer') {
      return reply.code(403).send({ error: 'viewer role is read-only' });
    }
    const body = approvalRespondSchema.safeParse(req.body);
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid body', issues: body.error.issues });
    }
    const approvalId = approvalParams.data.approvalId;
    const decidedBy = identity?.userId ?? 'anonymous';
    const history = await deps.store.load(granted.sessionId);
    const request = history.find(
      (event) => event.type === 'approval/requested' && event.approvalId === approvalId,
    );
    if (
      !request ||
      request.type !== 'approval/requested' ||
      history.some((event) => event.type === 'approval/resolved' && event.approvalId === approvalId)
    ) {
      return reply.code(409).send({ error: 'approval is not pending in this session' });
    }
    const requestIndex = history.indexOf(request);
    if (
      history
        .slice(requestIndex + 1)
        .some((event) => event.type === 'turn/end' || event.type === 'turn/cancel_requested')
    ) {
      return reply.code(409).send({ error: 'approval belongs to a stopped turn' });
    }
    const prefix = body.data.commandPrefix;
    if (prefix) {
      const call = history.find(
        (event) => event.type === 'tool/call' && event.callId === request.toolCallId,
      );
      const command =
        call?.type === 'tool/call' && call.name === 'bash'
          ? (call.args as { command?: unknown } | null)?.command
          : undefined;
      const literal = prefix.join(' ');
      if (
        typeof command !== 'string' ||
        !(command.trim() === literal || command.trim().startsWith(literal + ' '))
      ) {
        return reply.code(400).send({ error: 'command prefix must match the pending Bash call' });
      }
      await deps.store.append(
        granted.sessionId,
        [
          {
            eventId: newId(),
            at: new Date().toISOString(),
            type: 'approval/command_granted',
            approvalId,
            prefix,
            decidedBy,
          },
        ],
        { actor: decidedBy },
      );
    }
    // Durable trail (idempotent, first writer wins) + audit + channel reply.
    await deps.approvalStore?.resolve(approvalId, body.data.outcome, decidedBy);
    emitAudit({
      id: newId(),
      at: new Date().toISOString(),
      tenantId: identity?.tenantId ?? NIL_TENANT,
      userId: decidedBy,
      sessionId: granted.sessionId,
      action: 'approval/resolved',
      target: approvalId,
      result: body.data.outcome === 'allowed' ? 'ok' : 'denied',
    });
    approvalReplyPublisher(granted.sessionId).reply({
      approvalId,
      outcome: body.data.outcome,
      decidedBy,
    });
    pendingApprovals.delete(approvalId);
    return { ok: true };
  });

  // ---- M3: ACP HTTP binding (docs/design.md §11.2) ----------------------------

  /** Pending approval requests by approvalId (for respond-route lookups). */
  const pendingApprovals = new Map<string, ApprovalRequest>();
  /** Memoized per-session hub listeners used ONLY to publish human replies. */
  const replyPublishers = new Map<string, ReturnType<ApprovalHub['listen']>>();
  const approvalReplyPublisher = (sessionId: string): ReturnType<ApprovalHub['listen']> => {
    let listener = replyPublishers.get(sessionId);
    if (!listener) {
      if (!deps.approvals) {
        throw new Error('approval hub not configured');
      }
      listener = deps.approvals.listen(sessionId);
      replyPublishers.set(sessionId, listener);
    }
    return listener;
  };

  /** ServerEvent (internal wire) → ACP session/update params (v1 shapes). */
  const toAcpUpdate = (
    sessionId: string,
    event: ServerEvent,
  ): { method: 'session/update'; params: unknown } | null => {
    switch (event.type) {
      case 'session/activity':
        return {
          method: 'session/update',
          params: {
            sessionId,
            update: { sessionUpdate: 'session_info_update', _meta: { 'trinity.activity': event } },
          },
        };
      case 'session/memory_selection':
        return {
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'session_info_update',
              _meta: { 'trinity.memorySelection': event.receipt },
            },
          },
        };
      case 'session/prompt_queue':
        return {
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'session_info_update',
              _meta: { 'trinity.promptQueue': event },
            },
          },
        };
      case 'session/update': {
        const u = event.update;
        if (u.kind === 'agent_message_chunk') {
          return {
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: u.text },
              },
            },
          };
        }
        if (u.kind === 'agent_thought_chunk') {
          return {
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'agent_thought_chunk',
                content: { type: 'text', text: u.text },
              },
            },
          };
        }
        if (u.kind === 'tool_call') {
          return {
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'tool_call',
                toolCall: {
                  toolCallId: u.toolCallId,
                  title: u.title,
                  status: u.status,
                  kind: 'other',
                  ...(u.content !== undefined ? { content: u.content } : {}),
                },
              },
            },
          };
        }
        return null; // permission_request travels as a client-side REQUEST
      }
      case 'model/usage':
        return {
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'session_info_update',
              _meta: { 'trinity.modelUsage': event.usage },
            },
          },
        };
      case 'message/committed':
        return {
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: event.message.content },
              _meta: {
                'trinity.phase': event.message.phase,
                'trinity.citationList': event.message.citationList,
              },
            },
          },
        };
      case 'error':
        return {
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: `⚠️ ${event.message}` },
            },
          },
        };
      default:
        return null;
    }
  };

  /**
   * Full ACP message mapper for the stream relay: session/update
   * notifications PLUS client-side requests (permission_request →
   * session/request_permission). Returns the JSON-RPC envelope as a string.
   */
  const toAcpLine = (sessionId: string, event: ServerEvent): string | null => {
    if (event.type === 'session/update' && event.update.kind === 'permission_request') {
      const u = event.update;
      return JSON.stringify({
        jsonrpc: '2.0',
        id: u.approvalId,
        method: 'session/request_permission',
        params: {
          sessionId,
          toolCall: {
            toolCallId: u.toolCallId,
            title: u.title,
            status: 'pending',
            kind: 'execute',
          },
          options: [
            { optionId: 'once', kind: 'allow_once', name: 'Allow once' },
            { optionId: 'reject', kind: 'reject_once', name: 'Reject' },
          ],
        },
      });
    }
    const update = toAcpUpdate(sessionId, event);
    if (!update) return null;
    return JSON.stringify({ jsonrpc: '2.0', method: update.method, params: update.params });
  };

  const acpSessionQuerySchema = z.object({
    sessionId: z.uuid(),
    afterSeq: z.coerce.number().int().nonnegative().optional(),
    token: z.string().optional(),
  });

  /** Replay committed history as ACP notifications to a session's stream clients. */
  const replayAcpHistory = async (sessionId: string, afterSeq = 0): Promise<void> => {
    const senders = acpSenders.get(sessionId);
    if (!senders || senders.size === 0) return; // client resyncs via afterSeq
    const entries = await deps.store.loadRange(sessionId, { afterSeq });
    for (const { event } of entries) {
      const wire = logEventToServerEvent(sessionId, event);
      if (!wire) continue;
      const line = toAcpLine(sessionId, wire);
      if (!line) continue;
      for (const sender of senders) sender(line);
    }
  };

  /** Per-session ACP SSE senders (registered by GET /acp/stream). */
  const acpSenders = new Map<string, Set<(line: string) => void>>();

  /**
   * ACP event stream (docs/design.md §11.2): every SSE `data:` line carries
   * one JSON-RPC message. Committed log events replay with seq ids (§11.3
   * three-layer alignment); approval requests arrive as client-side
   * `session/request_permission` requests.
   */
  app.get('/acp/stream', async (req, reply) => {
    const query = acpSessionQuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ error: 'invalid query' });
    }
    const sessionId = query.data.sessionId;
    const granted = await authorizeSession(sessionId, req.identity, reply);
    if (!granted) return;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    const sendLine = (line: string): void => {
      reply.raw.write(`data: ${line}\n\n`);
    };
    const senders = acpSenders.get(sessionId) ?? new Set();
    senders.add(sendLine);
    acpSenders.set(sessionId, senders);

    const afterSeq = query.data.afterSeq ?? 0;
    let readerHandle: ReturnType<SessionEventReader['open']> | null = null;
    const cleanup: Array<() => void> = [];

    if (deps.eventReader && deps.queue) {
      const reader = deps.eventReader;
      try {
        const firstRetained = await reader.firstRetainedSeq(sessionId);
        const fillTo = firstRetained !== null ? firstRetained - 1 : undefined;
        const entries = await deps.store.loadRange(sessionId, {
          afterSeq,
          ...(fillTo !== undefined ? { toSeq: fillTo } : {}),
        });
        for (const { seq, event } of entries) {
          const wire = logEventToServerEvent(sessionId, event);
          if (!wire) continue;
          const line = toAcpLine(sessionId, wire);
          if (line) reply.raw.write(`id: ${seq}\ndata: ${line}\n\n`);
        }
        const cursor = entries.length > 0 ? entries[entries.length - 1]!.seq : afterSeq;
        readerHandle = reader.open(sessionId, cursor, ({ seq, event }) => {
          const wire = logEventToServerEvent(sessionId, event);
          if (!wire) return;
          const line = toAcpLine(sessionId, wire);
          if (line) reply.raw.write(`id: ${seq}\ndata: ${line}\n\n`);
        });
        await readerHandle.started;
      } catch (err) {
        sendLine(
          JSON.stringify({
            jsonrpc: '2.0',
            method: 'session/update',
            params: {
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: {
                  type: 'text',
                  text: `⚠️ event relay failed: ${err instanceof Error ? err.message : String(err)}`,
                },
              },
            },
          }),
        );
      }
    } else {
      // Inline mode: committed state reaches ACP clients through replay only.
      void replayAcpHistory(sessionId, afterSeq);
    }

    // Ephemeral live deltas (streaming chunks) for ACP clients.
    const liveListener = (event: ServerEvent): void => {
      const line = toAcpLine(sessionId, event);
      if (line) sendLine(line);
    };
    const liveSet = liveSubs.get(sessionId) ?? new Set();
    liveSet.add(liveListener);
    liveSubs.set(sessionId, liveSet);
    cleanup.push(() => liveSubs.get(sessionId)?.delete(liveListener));

    // Human approval requests reach ACP clients through the DURABLE log relay
    // (approval/requested → session/request_permission in toAcpLine); the
    // Pub/Sub hub stays the private request/response channel for the worker.

    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    const close = (): void => {
      clearInterval(heartbeat);
      for (const fn of cleanup) fn();
      readerHandle?.dispose();
      senders.delete(sendLine);
      if (senders.size === 0) acpSenders.delete(sessionId);
      reply.raw.end();
    };
    req.raw.on('close', close);
    await new Promise<void>((resolve) => {
      reply.raw.on('close', resolve);
    });
  });

  const jsonRpcError = (id: unknown, code: number, message: string): unknown => ({
    jsonrpc: '2.0',
    id: id ?? null,
    error: { code, message },
  });

  /**
   * Wait until the turn of `sessionId` ends by observing the in-process
   * fan-out (distributed live deltas / inline broadcast). Used to hold the
   * `session/prompt` JSON-RPC response until the turn actually stops (ACP
   * semantics). Capped so a crashed worker cannot hang the client forever.
   */
  const waitForTurnEnd = (
    sessionId: string,
    timeoutMs = 600_000,
    target?: { promptId: string; afterSeq: number },
  ): Promise<'completed' | 'aborted' | 'error'> =>
    new Promise((resolve) => {
      let settled = false;
      const cleanupFns: Array<() => void> = [];
      const done = (status: 'completed' | 'aborted' | 'error'): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        for (const fn of cleanupFns) fn();
        resolve(status);
      };
      const listener = (event: ServerEvent): void => {
        if (target) {
          if (
            event.type === 'session/turn_status' ||
            event.type === 'error' ||
            event.type === 'session/prompt_queue'
          )
            void checkTarget();
          return;
        }
        if (event.type === 'session/turn_status') {
          if (event.status === 'completed') done('completed');
          else if (event.status === 'aborted') done('aborted');
        } else if (event.type === 'error') {
          done('error');
        }
      };
      const checkTarget = async (): Promise<void> => {
        if (!target || settled) return;
        try {
          const entries = await deps.store.loadRange(sessionId, { afterSeq: target.afterSeq });
          const terminal = entries.find(
            ({ event }) =>
              (event.type === 'turn/end' || event.type === 'prompt/discarded') &&
              event.promptId === target.promptId,
          )?.event;
          if (terminal?.type === 'prompt/discarded') done('aborted');
          if (terminal?.type === 'turn/end')
            done(
              terminal.reason === 'completed'
                ? 'completed'
                : terminal.reason === 'aborted'
                  ? 'aborted'
                  : 'error',
            );
        } catch {
          done('error');
        }
      };
      const timer = setTimeout(() => done('aborted'), timeoutMs);
      for (const map of [subscribers, liveSubs]) {
        const set = map.get(sessionId) ?? new Set();
        set.add(listener);
        map.set(sessionId, set);
        cleanupFns.push(() => {
          map.get(sessionId)?.delete(listener);
        });
      }
      if (target) {
        if (deps.eventReader) {
          const reader = deps.eventReader.open(sessionId, target.afterSeq, ({ event }) => {
            if (
              (event.type === 'turn/end' || event.type === 'prompt/discarded') &&
              event.promptId === target.promptId
            )
              void checkTarget();
          });
          cleanupFns.push(() => reader.dispose());
          if (settled) reader.dispose();
          void reader.started.then(checkTarget).catch(() => done('error'));
        }
        void checkTarget();
      }
    });

  app.post('/acp', async (req, reply) => {
    const rpc = req.body as {
      jsonrpc?: string;
      id?: string | number;
      method?: string;
      params?: unknown;
    } | null;
    if (!rpc || rpc.jsonrpc !== '2.0' || typeof rpc.method !== 'string') {
      return reply.code(400).send(jsonRpcError(null, -32600, 'invalid JSON-RPC request'));
    }
    const id = rpc.id ?? null;
    const params = (rpc.params ?? {}) as Record<string, unknown>;
    const identity = req.identity;

    // Notifications (no id) get 202 without a body.
    const notify = (): unknown => reply.code(202).send();
    const result = (value: unknown): unknown => reply.send({ jsonrpc: '2.0', id, result: value });

    try {
      switch (rpc.method) {
        case 'initialize':
          return result({
            protocolVersion: 1,
            agentCapabilities: { loadSession: true },
            authMethods: [],
            agentInfo: { name: 'trinity-harness', version: '0.3.0' },
          });

        case 'authenticate':
          return result({});

        case 'session/new': {
          const cwd = typeof params['cwd'] === 'string' ? params['cwd'] : deps.workspaceRoot;
          const sessionId = newId();
          if (auth) {
            await auth.metas.create({
              id: sessionId,
              tenantId: identity!.tenantId,
              userId: identity!.userId,
              title: '',
              workspaceUri: cwd,
            });
          }
          await deps.store.append(
            sessionId,
            [
              {
                type: 'session/created',
                eventId: newId(),
                at: new Date().toISOString(),
                workspaceUri: cwd,
              },
            ],
            { actor: identity?.userId ?? 'anonymous' },
          );
          return result({ sessionId });
        }

        case 'session/load': {
          const sessionId = String(params['sessionId'] ?? '');
          const granted = await authorizeSession(sessionId, identity, reply);
          if (!granted) return; // 404 already sent
          // History replay: stream committed events to connected clients of
          // this session (the log is the source of truth, §11.3).
          void replayAcpHistory(granted.sessionId);
          return result({});
        }

        case 'session/prompt': {
          const sessionId = String(params['sessionId'] ?? '');
          const granted = await authorizeSession(sessionId, identity, reply);
          if (!granted) return;
          // M4: text-only [{type:"text",text}] OR multimodal blocks (images
          // and files as blob:// URIs, ACP resources, or inline base64).
          let content: ContentBlock[] | null;
          let text: string;
          const rawBlocks = params['prompt'];
          const allText =
            Array.isArray(rawBlocks) &&
            rawBlocks.every(
              (b) =>
                typeof b === 'object' &&
                b !== null &&
                (b as Record<string, unknown>)['type'] === 'text' &&
                typeof (b as Record<string, unknown>)['text'] === 'string',
            );
          if (allText) {
            const blocks = z
              .array(
                z.object({
                  type: z.literal('text'),
                  text: z.string().min(1).max(100_000),
                }),
              )
              .min(1)
              .safeParse(rawBlocks);
            if (!blocks.success) {
              return reply.send(jsonRpcError(id, -32602, 'prompt must be non-empty text blocks'));
            }
            text = blocks.data.map((b) => b.text).join('\n');
            content = null;
          } else {
            try {
              content = await acpBlocksToContent(deps.blobs, rawBlocks);
            } catch (err) {
              return reply.send(
                jsonRpcError(
                  id,
                  -32602,
                  err instanceof Error ? err.message : 'invalid attachment data',
                ),
              );
            }
            if (!content) {
              return reply.send(
                jsonRpcError(id, -32602, 'prompt must be text/image/file content blocks'),
              );
            }
            text =
              content.find((b) => b.kind === 'text')?.text ??
              content.map((b) => (b.kind === 'image' ? '[image]' : `[${b.kind}]`)).join(' ');
          }

          if (credentialMemoryRequest(text))
            return reply.send(
              jsonRpcError(id, -32602, 'Credentials cannot be stored in personal memory.'),
            );
          if (granted.meta?.sessionRole === 'main') {
            if (!identity || !deps.sessionRuns)
              return reply.send(jsonRpcError(id, -32603, 'Main chat queue unavailable'));
            const target = await enqueueMain(
              granted.meta,
              identity,
              text,
              content ?? [{ kind: 'text', text }],
            );
            const stop = await waitForTurnEnd(granted.sessionId, undefined, target);
            return result({
              stopReason:
                stop === 'completed' ? 'end_turn' : stop === 'aborted' ? 'cancelled' : 'refusal',
            });
          }
          // Same pipeline as POST /api/sessions/:id/messages.
          await auth?.metas.setTitleIfEmpty(granted.sessionId, text.trim().slice(0, 200));
          const appended = await deps.store.append(
            granted.sessionId,
            [
              {
                type: 'message/user',
                eventId: newId(),
                at: new Date().toISOString(),
                surfaceOp: 'append',
                content: content ?? [{ kind: 'text', text }],
              },
            ],
            { actor: identity?.userId ?? 'anonymous' },
          );
          if (deps.queue) {
            await deps.queue.enqueue({
              sessionId: granted.sessionId,
              prompt: text,
              ...(content !== null ? { content } : {}),
              actor: identity?.userId ?? 'anonymous',
              tenantId: identity?.tenantId ?? granted.meta?.tenantId ?? NIL_TENANT,
              promptSeq: appended.from,
              policy: policyFor(granted.meta),
            });
          } else if (deps.createLoop) {
            const sink = sinkFor(granted.sessionId);
            const loop = deps.createLoop(
              granted.sessionId,
              await workspaceRootFor(granted.meta, granted.sessionId),
            );
            runInline(granted.sessionId, (signal) =>
              loop.run(granted.sessionId, text, sink, {
                signal,
                actor: identity?.userId,
                contextGuard: executionGuard(granted.sessionId, identity?.userId ?? 'anonymous'),
                tenantId: identity?.tenantId,
                policy: policyFor(granted.meta),
                promptSeq: appended.from,
                ...(content !== null ? { content } : {}),
              }),
            );
          } else {
            return reply.send(jsonRpcError(id, -32603, 'no agent runner configured'));
          }

          // ACP: the prompt response arrives when the turn stops.
          const stop = await waitForTurnEnd(granted.sessionId);
          const stopReason =
            stop === 'completed' ? 'end_turn' : stop === 'aborted' ? 'cancelled' : 'refusal';
          return result({ stopReason });
        }

        case 'session/cancel': {
          const sessionId = String(params['sessionId'] ?? '');
          const granted = await authorizeSession(sessionId, identity, reply);
          if (!granted) return;
          if (identity?.role === 'viewer')
            return reply.send(jsonRpcError(id, -32603, 'viewer role is read-only'));
          await cancelTurn(granted.sessionId, identity?.userId ?? 'anonymous');
          return id === null ? notify() : result({});
        }

        case 'session/set_config_option': {
          const sessionId = String(params['sessionId'] ?? '');
          const granted = await authorizeSession(sessionId, identity, reply);
          if (!granted) return;
          if (params['optionId'] !== 'permission_policy') {
            return reply.send(
              jsonRpcError(id, -32602, `unsupported option: ${String(params['optionId'])}`),
            );
          }
          const value = String(params['value'] ?? '');
          let parsed: PermissionPolicy;
          try {
            parsed = parsePermissionPolicy(value);
          } catch {
            return reply.send(jsonRpcError(id, -32602, 'invalid permission policy'));
          }
          if (auth) {
            await auth.metas.setPolicy(granted.sessionId, value);
          }
          emitAudit({
            id: newId(),
            at: new Date().toISOString(),
            tenantId: identity?.tenantId ?? NIL_TENANT,
            userId: identity?.userId ?? 'anonymous',
            sessionId: granted.sessionId,
            action: 'session/policy',
            target: value.slice(0, 100),
            result: 'ok',
            detail: { policy: parsed },
          });
          return result({});
        }

        default:
          return reply.send(jsonRpcError(id, -32601, `method not found: ${rpc.method}`));
      }
    } catch (err) {
      return reply.send(jsonRpcError(id, -32603, err instanceof Error ? err.message : String(err)));
    }
  });

  // ---- SSE -------------------------------------------------------------------

  app.get('/api/sessions/:sessionId/events', async (req, reply) => {
    const sessionId = await sessionIdOf(req, reply);
    if (!sessionId) return;
    const granted = await authorizeSession(sessionId, req.identity, reply);
    if (!granted) return;

    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      // SSE through proxies: disable buffering (docs/design.md §16).
      'x-accel-buffering': 'no',
    });

    const send = (event: ServerEvent): void => {
      reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    const sendWithId = (seq: number, event: ServerEvent): void => {
      // SSE `id:` = session_events.seq (three-layer alignment, §11.3).
      reply.raw.write(`id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`);
    };

    const query = eventsQuerySchema.safeParse(req.query);
    const headerSeq = Number(req.headers['last-event-id']);
    const afterSeq =
      query.success && query.data.afterSeq !== undefined
        ? query.data.afterSeq
        : Number.isInteger(headerSeq) && headerSeq >= 0
          ? headerSeq
          : 0;

    let readerHandle: ReturnType<SessionEventReader['open']> | null = null;
    const cleanupRefs: { dispose?: () => void } = {};

    if (deps.eventReader && deps.queue) {
      // Distributed mode: PG gap-fill up to the retained window, then live.
      const reader = deps.eventReader;
      try {
        const firstRetained = await reader.firstRetainedSeq(sessionId);
        const fillTo = firstRetained !== null ? firstRetained - 1 : undefined;
        const entries = await deps.store.loadRange(sessionId, {
          afterSeq,
          ...(fillTo !== undefined ? { toSeq: fillTo } : {}),
        });
        for (const { seq, event } of entries) {
          const wire = logEventToServerEvent(sessionId, event);
          if (wire) sendWithId(seq, serverEventSchema.parse(wire));
        }
        const cursor = entries.length > 0 ? entries[entries.length - 1]!.seq : afterSeq;
        readerHandle = reader.open(sessionId, cursor, ({ seq, event }) => {
          const wire = logEventToServerEvent(sessionId, event);
          if (wire) sendWithId(seq, serverEventSchema.parse(wire));
        });
        await readerHandle.started;
      } catch (err) {
        send({
          type: 'error',
          sessionId,
          message: `event relay failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      // Ephemeral live deltas (Pub/Sub fan-out registered at build time).
      if (deps.liveEvents) {
        const liveListener = (event: ServerEvent): void => send(event);
        const set = liveSubs.get(sessionId) ?? new Set();
        set.add(liveListener);
        liveSubs.set(sessionId, set);
        cleanupRefs.dispose = () => {
          liveSubs.get(sessionId)?.delete(liveListener);
        };
      }
      // Audit-only log entries need not produce wire frames. Flush readiness
      // after both durable and live subscriptions are installed.
      reply.raw.write(': connected\n\n');
    } else {
      reply.raw.write(': connected\n\n');
      // Inline execution uses the same durable replay cursor as workers.
      let cursor = afterSeq;
      let closed = false;
      let pending = Promise.resolve();
      const relay = (live?: ServerEvent, failure?: ServerEvent): void => {
        pending = pending
          .then(async () => {
            if (closed) return;
            if (live) {
              send(live);
              return;
            }
            const entries = await deps.store.loadRange(sessionId, { afterSeq: cursor });
            let errorDelivered = false;
            for (const { seq, event } of entries) {
              if (closed) return;
              const wire = logEventToServerEvent(sessionId, event);
              if (wire) {
                sendWithId(seq, serverEventSchema.parse(wire));
                if (wire.type === 'error') errorDelivered = true;
              }
              cursor = seq;
            }
            // Runner failures may have no durable terminal event. Reset inherited
            // EventSource IDs so the client does not discard this notification.
            if (failure && !errorDelivered && !closed)
              reply.raw.write(`id:\ndata: ${JSON.stringify(failure)}\n\n`);
          })
          .catch((err: unknown) => {
            if (!closed)
              reply.raw.write(
                `id:\ndata: ${JSON.stringify({
                  type: 'error',
                  sessionId,
                  message: `event relay failed: ${err instanceof Error ? err.message : String(err)}`,
                })}\n\n`,
              );
          });
      };
      const listener = (event: ServerEvent): void => {
        const delta =
          event.type === 'session/update' &&
          (event.update.kind === 'agent_message_chunk' ||
            event.update.kind === 'agent_thought_chunk');
        relay(delta ? event : undefined, event.type === 'error' ? event : undefined);
      };
      const listeners = subscribers.get(sessionId) ?? new Set();
      listeners.add(listener);
      subscribers.set(sessionId, listeners);
      relay();
      cleanupRefs.dispose = () => {
        closed = true;
        subscribers.get(sessionId)?.delete(listener);
      };
    }

    // Heartbeat so clients can distinguish "idle" from "dead" (design.md §11.3).
    const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
    const cleanup = (): void => {
      clearInterval(heartbeat);
      cleanupRefs.dispose?.();
      readerHandle?.dispose();
      reply.raw.end();
    };
    req.raw.on('close', cleanup);

    await new Promise<void>((resolve) => {
      reply.raw.on('close', resolve);
    });
  });

  await app.ready();
  return app;
}
