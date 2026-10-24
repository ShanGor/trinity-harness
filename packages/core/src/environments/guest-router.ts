import { z } from 'zod';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  environmentNodeSchema,
  guestEnvelopeSchema,
  guestResponseSchema,
  guestOperationSchema,
  GUEST_WIRE_BYTES,
  type EnvironmentPort,
  type EnvironmentStore,
  type EnvironmentNode,
  type GuestRequestPort,
  type GuestOperation,
  type GuestValue,
  type SessionMetaStore,
  type UserStore,
} from '@trinity-harness/contracts';

export class GuestUnavailableError extends Error {
  readonly code = 'GUEST_UNAVAILABLE';
  constructor() {
    super(
      'Personal VM execution is unavailable; no operation was retried or routed locally. A lost response can have an unknown effect.',
    );
  }
}

/** Authenticated metadata, never model arguments, selects physical execution. */
export class FirecrackerGuestRouter implements GuestRequestPort {
  constructor(
    private readonly environments: EnvironmentPort,
    private readonly store: Pick<EnvironmentStore, 'get'>,
    private readonly metas: Pick<SessionMetaStore, 'get'>,
    private readonly users: Pick<UserStore, 'findById'>,
    private readonly nodes: readonly EnvironmentNode[],
    private readonly token: string,
    private readonly workspaceRoot: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    if (token.length < 32 || nodes.length === 0) throw new GuestUnavailableError();
    nodes.forEach((node) => environmentNodeSchema.parse(node));
  }
  async call(sessionId: string, input: GuestOperation, signal?: AbortSignal): Promise<GuestValue> {
    const operation = guestOperationSchema.parse(input);
    const meta = await this.metas.get(sessionId);
    const user = meta ? await this.users.findById(meta.userId) : null;
    if (
      !meta?.workspaceUri ||
      meta.closedAt ||
      meta.scope === 'team' ||
      !meta.kind ||
      !user ||
      user.tenantId !== meta.tenantId ||
      user.role === 'viewer'
    )
      throw new GuestUnavailableError();
    const workspace = path.relative(
      path.resolve(this.workspaceRoot),
      path.resolve(meta.workspaceUri),
    );
    guestEnvelopeSchema.shape.workspace.parse(workspace);
    const identity = { tenantId: meta.tenantId, userId: meta.userId, role: user.role };
    let environment = await this.store.get(identity);
    if (environment?.state === 'starting') environment = await this.environments.get(identity);
    if (
      (!environment || environment.state === 'stopped') &&
      ['processRead', 'processWrite', 'processKill'].includes(operation.kind)
    )
      throw new GuestUnavailableError();
    if (!environment || environment.state === 'stopped')
      environment = await this.environments.wake(identity, signal);
    if (environment.state !== 'running') throw new GuestUnavailableError();
    const node = this.nodes.find((candidate) => candidate.id === environment.nodeId);
    if (!node) throw new GuestUnavailableError();
    const request = guestEnvelopeSchema.parse({
      requestId: randomUUID(),
      environmentId: environment.id,
      generation: environment.generation,
      sessionId,
      workspace,
      operation,
    });
    const active = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(125_000)]);
    try {
      const response = await this.fetcher(new URL('/guest', node.endpoint), {
        method: 'POST',
        redirect: 'error',
        signal: active,
        headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ environment, request }),
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new GuestUnavailableError();
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > GUEST_WIRE_BYTES) throw new GuestUnavailableError();
          chunks.push(chunk.value);
        }
        const result = guestResponseSchema.parse(
          JSON.parse(Buffer.concat(chunks).toString('utf8')),
        );
        if (result.requestId !== request.requestId || result.generation !== environment.generation)
          throw new GuestUnavailableError();
        return result.value;
      } finally {
        await reader.cancel();
        reader.releaseLock();
      }
    } catch {
      signal?.throwIfAborted();
      throw new GuestUnavailableError();
    }
  }
}

export const guestDeploymentEnvShape = {
  EXECUTION_DRIVER: z.enum(['local', 'firecracker']).default('local'),
  FIRECRACKER_NODES: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (!value) return [];
      try {
        return z.array(environmentNodeSchema).min(1).max(32).parse(JSON.parse(value));
      } catch {
        ctx.addIssue({ code: 'custom', message: 'Invalid Firecracker node inventory' });
        return z.NEVER;
      }
    }),
  NODE_RUNTIME_TOKEN: z.string().min(32).optional(),
};
export function validateGuestDeployment(
  env: {
    EXECUTION_DRIVER: string;
    FIRECRACKER_NODES: readonly EnvironmentNode[];
    NODE_RUNTIME_TOKEN?: string;
    BROWSER_DRIVER: string;
  },
  hasDatabase: boolean,
): void {
  if (
    env.EXECUTION_DRIVER === 'firecracker' &&
    (!hasDatabase ||
      !env.FIRECRACKER_NODES.length ||
      !env.NODE_RUNTIME_TOKEN ||
      env.BROWSER_DRIVER !== 'zendriver')
  )
    throw new Error(
      'Firecracker execution requires PostgreSQL, FIRECRACKER_NODES, NODE_RUNTIME_TOKEN and BROWSER_DRIVER=zendriver',
    );
}
