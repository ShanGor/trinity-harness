import type {
  AgentLoop,
  AgentTaskQueue,
  ApprovalHub,
  ApprovalRequest,
  ApprovalStore,
  AuditEmitter,
  AuditStore,
  BlobStore,
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
  UsagePort,
  UserStore,
} from '@trinity-harness/contracts';
import {
  personalFoldersQuerySchema,
  serverEventSchema,
  workspaceSelectionSchema,
} from '@trinity-harness/shared';
import type { ServerEvent } from '@trinity-harness/shared';
import Fastify from 'fastify';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { mkdir } from 'node:fs/promises';
import { z } from 'zod';

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

const approvalRespondSchema = z.object({
  outcome: z.enum(['allowed', 'rejected']),
});

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
        message: { role: 'assistant', content: event.content },
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
    case 'message/user':
      return {
        type: 'message/committed',
        sessionId,
        message: {
          role: 'user',
          content: blocksToText(event.content),
          ...(mediaOf(event.content) !== undefined ? { attachments: mediaOf(event.content) } : {}),
        },
      };
    case 'message/assistant':
      return {
        type: 'message/committed',
        sessionId,
        message: { role: 'assistant', content: blocksToText(event.content) },
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
  store: SessionStore;
  workspaceRoot: string;
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
  turns?: { cancel(sessionId: string): void };
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
      if (url === '/api/health' || url.startsWith('/api/auth/')) return;
      const token = tokenFrom(req);
      const identity = token ? await auth.tokens.verify(token) : null;
      if (!identity) {
        return reply.code(401).send({ error: 'unauthorized' });
      }
      req.identity = identity;
    });
  }

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
        id: crypto.randomUUID(),
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
    return { sessionId, meta };
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
   * (`$WORKSPACE_ROOT/<user_id>` or `<team_id>`). Meta-less sessions
   * (M1 memory mode) fall back to the deployment root.
   */
  const workspaceRootFor = (meta: SessionMeta | null | undefined): string =>
    meta?.workspaceUri ?? deps.workspaceRoot;

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
          id: crypto.randomUUID(),
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
        id: crypto.randomUUID(),
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
          id: crypto.randomUUID(),
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
        id: crypto.randomUUID(),
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
          id: crypto.randomUUID(),
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
          id: crypto.randomUUID(),
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
              id: crypto.randomUUID(),
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
            id: crypto.randomUUID(),
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
    const sessionId = crypto.randomUUID();
    const identity = req.identity;

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
          id: crypto.randomUUID(),
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
    let workspaceDir: string;
    if (scope === 'personal' && identity) {
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

    if (auth) {
      // Ownership row first; the event log references it by id.
      await auth.metas.create({
        id: sessionId,
        tenantId: identity!.tenantId,
        userId: identity!.userId,
        title: body.data.title ?? '',
        workspaceUri: workspaceDir,
        scope,
        ...(scopeId !== undefined ? { scopeId } : {}),
        ...(policyName !== undefined ? { policy: policyName } : {}),
      });
    }
    await deps.store.append(
      sessionId,
      [
        {
          type: 'session/created',
          eventId: crypto.randomUUID(),
          at: new Date().toISOString(),
          workspaceUri: workspaceDir,
        },
      ],
      { actor: identity?.userId ?? 'anonymous' },
    );
    emitAudit({
      id: crypto.randomUUID(),
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

  app.get('/api/sessions/:sessionId/messages', async (req, reply) => {
    const sessionId = await sessionIdOf(req, reply);
    if (!sessionId) return;
    const granted = await authorizeSession(sessionId, req.identity, reply);
    if (!granted) return;
    const surface = await deps.store.projectMessages(granted.sessionId);
    return {
      messages: surface.map((m) => ({ role: m.role, content: blocksToText(m.content) })),
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
    deps.turns?.cancel(sessionId);
    await deps.store.append(
      sessionId,
      [{ type: 'session/closed', eventId: crypto.randomUUID(), at: new Date().toISOString() }],
      { actor: identity.userId },
    );
    await auth.metas.close(sessionId);
    emitAudit({
      id: crypto.randomUUID(),
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
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        tenantId: identity.tenantId,
        userId: identity.userId,
        sessionId: granted.sessionId,
        action: 'session/prompt',
        result: 'denied',
      });
      return reply.code(403).send({ error: 'viewer role is read-only' });
    }
    await auth?.metas.setTitleIfEmpty(sessionId, body.data.text.trim().slice(0, 200));
    emitAudit({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      tenantId: identity?.tenantId ?? NIL_TENANT,
      userId: identity?.userId ?? 'anonymous',
      sessionId: granted.sessionId,
      action: 'session/prompt',
      result: 'ok',
    });

    if (deps.queue) {
      // M3: the user message is committed HERE (server-side, actor-stamped)
      // so the turn task carries its exact seq (promptSeq) for the
      // permission-gated prompt path (docs/design.md §11.3, §12).
      const appended = await deps.store.append(
        granted.sessionId,
        [
          {
            type: 'message/user',
            eventId: crypto.randomUUID(),
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
          eventId: crypto.randomUUID(),
          at: new Date().toISOString(),
          surfaceOp: 'append',
          content: promptContent(body.data.text, body.data.attachments),
        },
      ],
      { actor: identity?.userId ?? 'anonymous' },
    );
    const sink = sinkFor(sessionId);
    const loop = deps.createLoop(sessionId, workspaceRootFor(granted.meta));
    // Run detached: SSE subscribers observe progress; failures surface as events.
    void loop
      .run(sessionId, body.data.text, sink, {
        actor: identity?.userId ?? 'anonymous',
        tenantId: identity?.tenantId,
        policy: policyFor(granted.meta),
        promptSeq: appended.from,
        ...(body.data.attachments !== undefined
          ? { content: promptContent(body.data.text, body.data.attachments) }
          : {}),
      })
      .catch((err: unknown) => {
        broadcast(sessionId, {
          type: 'error',
          sessionId,
          message: err instanceof Error ? err.message : String(err),
        });
      });
    return reply.code(202).send({ accepted: true });
  });

  // ---- M4: attachments & blob storage (docs/design.md §10) ------------------

  if (deps.blobs) {
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
        emitAudit({
          id: crypto.randomUUID(),
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
          .send({ uri: blob.uri, mimeType: query.data.mime, size: data.byteLength });
      },
    );

    // Blob download (UI image rendering, spill retrieval). Keys are
    // unguessable UUIDs; ownership hardening (per-session ACL) is M5+.
    app.get('/api/blobs/*', async (req, reply) => {
      const key = (req.params as Record<string, string>)['*'] ?? '';
      if (!key || key.includes('..')) {
        return reply.code(400).send({ error: 'invalid blob key' });
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
      id: crypto.randomUUID(),
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
    deps.turns?.cancel(granted.sessionId);
    emitAudit({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      tenantId: identity?.tenantId ?? NIL_TENANT,
      userId: identity?.userId ?? 'anonymous',
      sessionId: granted.sessionId,
      action: 'session/cancel',
      result: 'ok',
    });
    return { ok: true };
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
    // Durable trail (idempotent, first writer wins) + audit + channel reply.
    await deps.approvalStore?.resolve(approvalId, body.data.outcome, decidedBy);
    emitAudit({
      id: crypto.randomUUID(),
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
      case 'message/committed':
        return {
          method: 'session/update',
          params: {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: event.message.content },
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
        if (event.type === 'session/turn_status') {
          if (event.status === 'completed') done('completed');
          else if (event.status === 'aborted') done('aborted');
        } else if (event.type === 'error') {
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
          const sessionId = crypto.randomUUID();
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
                eventId: crypto.randomUUID(),
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

          // Same pipeline as POST /api/sessions/:id/messages.
          await auth?.metas.setTitleIfEmpty(granted.sessionId, text.trim().slice(0, 200));
          const appended = await deps.store.append(
            granted.sessionId,
            [
              {
                type: 'message/user',
                eventId: crypto.randomUUID(),
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
            void deps
              .createLoop(granted.sessionId, workspaceRootFor(granted.meta))
              .run(granted.sessionId, text, sink, {
                actor: identity?.userId ?? 'anonymous',
                tenantId: identity?.tenantId,
                policy: policyFor(granted.meta),
                promptSeq: appended.from,
                ...(content !== null ? { content } : {}),
              })
              .catch((err: unknown) => {
                broadcast(granted.sessionId, {
                  type: 'error',
                  sessionId: granted.sessionId,
                  message: err instanceof Error ? err.message : String(err),
                });
              });
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
          deps.turns?.cancel(granted.sessionId);
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
            id: crypto.randomUUID(),
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
    } else {
      // Inline mode: in-process broadcast (M1 path, no seq replay).
      send({
        type: 'session/update',
        sessionId,
        update: { kind: 'agent_thought_chunk', text: '' },
      });
      const listeners = subscribers.get(sessionId) ?? new Set();
      listeners.add(send);
      subscribers.set(sessionId, listeners);
      cleanupRefs.dispose = () => {
        subscribers.get(sessionId)?.delete(send);
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
