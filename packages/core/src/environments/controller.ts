import {
  environmentNodeSchema,
  nodeRuntimeResultSchema,
  type EnvironmentNode,
  type EnvironmentPort,
  type EnvironmentMaintenancePort,
  type EnvironmentNodeDrainResult,
  type EnvironmentRecord,
  type EnvironmentStore,
  type Identity,
  type NodeRuntimePort,
  type NodeRuntimeResult,
} from '@trinity-harness/contracts';

/** Physical endpoints and host authority never cross the browser/model boundary. */
export class HttpNodeRuntime implements NodeRuntimePort {
  constructor(
    private readonly endpoint: string,
    private readonly token: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    environmentNodeSchema.shape.endpoint.parse(endpoint);
    if (token.length < 32) throw new Error('Invalid node runtime token');
  }
  async command(
    operation: 'start' | 'stop' | 'status',
    environment: EnvironmentRecord,
    signal?: AbortSignal,
  ): Promise<NodeRuntimeResult> {
    const response = await this.fetcher(new URL('/instances', this.endpoint), {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ operation, environment }),
    });
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error('Node unavailable');
    }
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 4096) throw new Error('Node response overflow');
        chunks.push(chunk.value);
      }
      const result = nodeRuntimeResultSchema.parse(
        JSON.parse(Buffer.concat(chunks).toString('utf8')),
      );
      if (result.generation !== environment.generation) throw new Error('Stale node generation');
      return result;
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
  }
}

export class EnvironmentController implements EnvironmentPort, EnvironmentMaintenancePort {
  constructor(
    private readonly store: EnvironmentStore,
    private readonly nodes: readonly EnvironmentNode[],
    private readonly runtimes: ReadonlyMap<string, NodeRuntimePort>,
  ) {}
  async get(identity: Identity, signal?: AbortSignal): Promise<EnvironmentRecord | null> {
    return this.store.runShared(
      identity,
      async (active) => {
        const record = await this.store.get(identity);
        if (!record || record.state === 'stopped' || record.state === 'quarantined') return record;
        const runtime = this.runtimes.get(record.nodeId);
        if (!runtime) return record;
        try {
          const result = await runtime.command('status', record, active);
          active.throwIfAborted();
          return await this.store.transition(record, result.state, record.state);
        } catch {
          active.throwIfAborted();
          return this.store.transition(record, 'quarantined', record.state);
        }
      },
      signal,
    );
  }
  private async command(
    operation: 'start' | 'stop',
    record: EnvironmentRecord,
    signal?: AbortSignal,
  ): Promise<EnvironmentRecord> {
    const runtime = this.runtimes.get(record.nodeId);
    if (!runtime) throw new Error('Assigned node is unavailable; automatic takeover is disabled');
    try {
      const result = await runtime.command(operation, record, signal);
      if (operation === 'stop' && result.state !== 'stopped')
        throw new Error('Node did not confirm the environment stopped');
      return await this.store.transition(record, result.state);
    } catch (error) {
      // Timeout/transport loss never establishes that a host or VM stopped.
      await this.store.transition(record, 'quarantined');
      throw error;
    }
  }
  async wake(identity: Identity, signal?: AbortSignal): Promise<EnvironmentRecord> {
    if (identity.role === 'viewer') throw new Error('Execution permission denied');
    return this.store.run(
      identity,
      async (active) => {
        const record = await this.store.reserve(identity, this.nodes);
        if (await this.store.isNodeDraining(record.nodeId))
          throw Object.assign(new Error('Environment node is in maintenance'), {
            code: 'NODE_DRAINING',
          });
        if (record.state === 'quarantined') throw new Error('Environment requires host recovery');
        if (record.state === 'running') return record;
        return this.command('start', record, active);
      },
      signal,
    );
  }
  async suspend(identity: Identity, signal?: AbortSignal): Promise<EnvironmentRecord | null> {
    if (identity.role === 'viewer') throw new Error('Execution permission denied');
    return this.store.run(
      identity,
      async (active) => {
        const record = await this.store.get(identity);
        if (!record || record.state === 'stopped') return record;
        return this.command('stop', record, active);
      },
      signal,
    );
  }
  async drainNode(nodeId: string, signal?: AbortSignal): Promise<EnvironmentNodeDrainResult> {
    if (!this.nodes.some((node) => node.id === nodeId))
      throw Object.assign(new Error('Unknown Firecracker node'), { code: 'UNKNOWN_NODE' });
    await this.store.beginNodeDrain(nodeId);
    signal?.throwIfAborted();
    const active = (await this.store.listNodeEnvironments(nodeId)).filter(
      (record) => record.state !== 'stopped',
    );
    let cursor = 0;
    let failed = 0;
    const concurrency = Math.min(4, active.length);
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        for (;;) {
          signal?.throwIfAborted();
          const index = cursor++;
          const record = active[index];
          if (!record) return;
          try {
            await this.suspend(
              { tenantId: record.tenantId, userId: record.userId, role: 'developer' },
              signal,
            );
          } catch {
            // Keep draining the other owners; the final state check gates release.
            failed += 1;
          }
        }
      }),
    );
    const remaining = (await this.store.listNodeEnvironments(nodeId)).filter(
      (record) => record.state !== 'stopped',
    ).length;
    return {
      nodeId,
      state: 'draining',
      stopped: active.length - remaining,
      remaining,
      failed,
    };
  }
  async resumeNode(nodeId: string): Promise<void> {
    if (!this.nodes.some((node) => node.id === nodeId))
      throw Object.assign(new Error('Unknown Firecracker node'), { code: 'UNKNOWN_NODE' });
    const active = (await this.store.listNodeEnvironments(nodeId)).some(
      (record) => record.state !== 'stopped',
    );
    if (active)
      throw Object.assign(new Error('Node still has active environments'), { code: 'NODE_ACTIVE' });
    await this.store.endNodeDrain(nodeId);
  }
}
