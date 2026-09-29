import { z } from 'zod';

/**
 * Permission & approval contracts (docs/design.md §12).
 *
 * Per-session tool-execution policy (permission presets, §12.1):
 * - `workspace-write + ask` (default): writes inside the workspace are free,
 *   anything dangerous (bash, writes outside the workspace) asks the user;
 * - `read-only`: every write/command asks;
 * - `danger-full-access + never` (CI): everything allowed, never ask.
 *
 * The approval channel is fail-closed (§12.2): a request with no responder
 * resolves to `rejected` — never to `allowed`.
 */

/** Tool-execution decision produced by the policy for one tool call. */
export type PermissionDecision = 'allowed' | 'ask' | 'denied';

export const permissionPolicySchema = z.object({
  /** What happens when the policy decides 'ask' and nobody answers in time. */
  onAsk: z.enum(['ask', 'deny']),
  /** Per-tool decision overrides (e.g. { bash: 'ask', read_file: 'allowed' }). */
  tools: z.record(z.string(), z.enum(['allowed', 'ask', 'denied'])),
  /**
   * Extra guard applied to `bash` commands under 'ask' (design.md §12.1
   * "工作区内写自由"): commands classified as pure workspace-internal are
   * auto-allowed instead of interrupting the user. Ignored when the tool
   * decision is already 'allowed' or 'denied'.
   */
  allowWorkspaceInternalBash: z.boolean(),
});
export type PermissionPolicy = z.infer<typeof permissionPolicySchema>;

/** Presets from design.md §12.1. */
export const PERMISSION_PRESETS = {
  'workspace-write': {
    onAsk: 'ask',
    tools: {},
    allowWorkspaceInternalBash: true,
  },
  'read-only': {
    onAsk: 'ask',
    tools: {
      read_file: 'allowed',
      glob: 'allowed',
      bash: 'denied',
      write_file: 'ask',
      edit_file: 'ask',
    },
    allowWorkspaceInternalBash: false,
  },
  'danger-full-access': {
    // 'never ask' (design.md §12.1): the '*' rule leaves no 'ask' decisions,
    // so onAsk is moot — set to 'deny' to stay fail-closed for anything that
    // still slips through as 'ask'.
    onAsk: 'deny',
    tools: { '*': 'allowed' },
    allowWorkspaceInternalBash: false,
  },
} as const satisfies Record<string, PermissionPolicy>;

/** Parse a preset name (or a raw JSON policy object) into a full policy. */
export function parsePermissionPolicy(input: string): PermissionPolicy {
  const preset = (PERMISSION_PRESETS as Record<string, PermissionPolicy>)[input];
  if (preset) return preset;
  const parsed = permissionPolicySchema.safeParse(JSON.parse(input));
  if (!parsed.success) {
    throw new Error(`invalid permission policy: ${parsed.error.message}`);
  }
  return parsed.data;
}

/** What is being approved: a single tool call inside a running turn. */
export interface ApprovalRequest {
  sessionId: string;
  /** UUID identifying this request; echoed by the client reply. */
  approvalId: string;
  toolCallId: string;
  toolName: string;
  /** Redacted, size-bounded argument preview (never full secrets, §5). */
  argsPreview: string;
}

export interface ApprovalReply {
  approvalId: string;
  outcome: 'allowed' | 'rejected';
  /** User who decided (event-log actor + audit trail). */
  decidedBy: string;
}

/**
 * Approval channel (docs/design.md §12.2). The worker-side client blocks the
 * tool wave until the human answers (or the turn is cancelled); the server-side
 * hub fans requests out to connected clients (Web UI, acp-gateway) and routes
 * the first reply back. A missing component or timeout resolves to `rejected`.
 */
export interface ApprovalRequester {
  /** Blocks until a reply arrives or the signal aborts (turn cancelled). */
  request(req: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalReply>;
}

export interface ApprovalListener {
  /** Called for every approval request of this session. */
  onRequest(handler: (req: ApprovalRequest) => void): void;
  /** Resolves the pending request; ignored when the id is unknown. */
  reply(reply: ApprovalReply): void;
  dispose(): void;
  [Symbol.dispose](): void;
}

export interface ApprovalHub {
  /** Server side: fan requests out to listeners, route replies back. */
  listen(sessionId: string): ApprovalListener;
}

/**
 * Persistent approval record (docs/design.md §15 `approvals` table).
 * Both the request AND the outcome are recorded (审批留痕, §12.2) — the request
 * is written by the worker when the policy gates a tool call; the outcome
 * columns are filled by whoever receives the human reply first (PG row,
 * idempotent).
 */
export interface ApprovalRecord {
  id: string;
  sessionId: string;
  toolCallId: string;
  toolName: string;
  argsPreview: string;
  /** null while the request is still pending. */
  outcome: 'allowed' | 'rejected' | null;
  decidedBy: string | null;
  createdAt: string;
  decidedAt: string | null;
}

export interface ApprovalStore {
  /** Insert the pending request (idempotent on id). */
  request(record: ApprovalRecord): Promise<void>;
  /** Fill in the outcome (idempotent on id; first writer wins). */
  resolve(id: string, outcome: 'allowed' | 'rejected', decidedBy: string): Promise<void>;
  /** Latest approvals of a session, newest first (audit/verification). */
  list(sessionId: string, limit?: number): Promise<ApprovalRecord[]>;
}
