import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { and, eq, sql } from 'drizzle-orm';
import {
  environmentRecordSchema,
  ENVIRONMENT_MEMORY_OVERHEAD_MIB,
  type EnvironmentStore,
  type EnvironmentRecord,
  type EnvironmentNode,
  type Identity,
} from '@trinity-harness/contracts';
import type { Db } from './client.js';
import { assistantEnvironments, environmentEvents, firecrackerNodeMaintenance } from './schema.js';

function scope(identity: Identity) {
  return and(
    eq(assistantEnvironments.tenantId, identity.tenantId),
    eq(assistantEnvironments.userId, identity.userId),
  );
}
export class PgEnvironmentStore implements EnvironmentStore {
  constructor(
    private readonly db: Db,
    private readonly locks: pg.Pool,
  ) {}
  async run<T>(
    identity: Identity,
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.runWithLock(identity, action, signal, false);
  }
  async runShared<T>(
    identity: Identity,
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    return this.runWithLock(identity, action, signal, true);
  }
  private async runWithLock<T>(
    identity: Identity,
    action: (signal: AbortSignal) => Promise<T>,
    signal: AbortSignal | undefined,
    shared: boolean,
  ): Promise<T> {
    signal?.throwIfAborted();
    const client = await this.locks.connect();
    const lost = new AbortController();
    let locked = false,
      destroyed = false;
    const abort = (): void => {
      lost.abort();
      if (!locked && !destroyed) {
        destroyed = true;
        client.release(true);
      }
    };
    const disconnect = (): void => lost.abort();
    client.on('error', disconnect);
    signal?.addEventListener('abort', abort, { once: true });
    const key = `${identity.tenantId}/${identity.userId}`;
    try {
      if (signal?.aborted) abort();
      lost.signal.throwIfAborted();
      await client.query(
        `select pg_advisory_lock${shared ? '_shared' : ''}(hashtextextended($1, 23997))`,
        [key],
      );
      locked = true;
      return await action(AbortSignal.any([lost.signal, ...(signal ? [signal] : [])]));
    } finally {
      signal?.removeEventListener('abort', abort);
      client.removeListener('error', disconnect);
      if (!destroyed) {
        try {
          if (locked && !lost.signal.aborted)
            await client.query(
              `select pg_advisory_unlock${shared ? '_shared' : ''}(hashtextextended($1, 23997))`,
              [key],
            );
        } finally {
          client.release(lost.signal.aborted);
        }
      }
    }
  }
  async get(identity: Identity): Promise<EnvironmentRecord | null> {
    const [row] = await this.db.select().from(assistantEnvironments).where(scope(identity));
    return row ? environmentRecordSchema.parse(row) : null;
  }
  async reserve(identity: Identity, nodes: readonly EnvironmentNode[]): Promise<EnvironmentRecord> {
    return this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(89274315)`);
      const [previous] = await tx.select().from(assistantEnvironments).where(scope(identity));
      if (previous && previous.state !== 'stopped') {
        const [maintenance] = await tx
          .select({ nodeId: firecrackerNodeMaintenance.nodeId })
          .from(firecrackerNodeMaintenance)
          .where(eq(firecrackerNodeMaintenance.nodeId, previous.nodeId));
        if (maintenance)
          throw Object.assign(new Error('Node is in maintenance'), { code: 'NODE_DRAINING' });
        return environmentRecordSchema.parse(previous);
      }
      const allocations = await tx.select().from(assistantEnvironments);
      const draining = await tx
        .select({ nodeId: firecrackerNodeMaintenance.nodeId })
        .from(firecrackerNodeMaintenance);
      const drainingIds = new Set(draining.map((entry) => entry.nodeId));
      const resources = { vcpus: previous?.vcpus ?? 2, memoryMiB: previous?.memoryMiB ?? 2048 };
      const choices = nodes
        .filter((node) => (!previous || previous.nodeId === node.id) && !drainingIds.has(node.id))
        .map((node) => {
          const used = allocations.filter(
            (env) => env.nodeId === node.id && env.state !== 'stopped',
          );
          return {
            node,
            cpu: used.reduce((sum, env) => sum + env.vcpus, 0),
            memory: used.reduce(
              (sum, env) => sum + env.memoryMiB + ENVIRONMENT_MEMORY_OVERHEAD_MIB,
              0,
            ),
          };
        })
        .filter(
          (entry) =>
            entry.cpu + resources.vcpus <= entry.node.vcpus &&
            entry.memory + resources.memoryMiB + ENVIRONMENT_MEMORY_OVERHEAD_MIB <=
              entry.node.memoryMiB,
        )
        .sort((a, b) => a.memory / a.node.memoryMiB - b.memory / b.node.memoryMiB);
      const node = choices[0]?.node;
      if (!node)
        throw Object.assign(new Error('No node capacity available'), { code: 'WAITING_CAPACITY' });
      const record: EnvironmentRecord = {
        id: previous?.id ?? randomUUID(),
        tenantId: identity.tenantId,
        userId: identity.userId,
        nodeId: node.id,
        generation: randomUUID(),
        state: 'starting',
        ...resources,
      };
      if (previous)
        await tx
          .update(assistantEnvironments)
          .set(record)
          .where(eq(assistantEnvironments.id, previous.id));
      else await tx.insert(assistantEnvironments).values(record);
      await tx
        .insert(environmentEvents)
        .values({ id: randomUUID(), environmentId: record.id, type: 'reserved', snapshot: record });
      return record;
    });
  }
  async authorizeNode(
    record: EnvironmentRecord,
    operation: 'start' | 'stop' | 'status' | 'guest' | 'guest-complete' = 'guest',
  ): Promise<boolean> {
    const [row] = await this.db
      .select()
      .from(assistantEnvironments)
      .where(eq(assistantEnvironments.id, record.id));
    const authorized =
      !!row &&
      row.id === record.id &&
      row.state === record.state &&
      row.nodeId === record.nodeId &&
      row.generation === record.generation &&
      row.userId === record.userId &&
      row.tenantId === record.tenantId &&
      row.vcpus === record.vcpus &&
      row.memoryMiB === record.memoryMiB;
    if (!authorized) return false;
    return (
      operation === 'stop' ||
      operation === 'status' ||
      operation === 'guest-complete' ||
      !(await this.isNodeDraining(record.nodeId))
    );
  }
  async isNodeDraining(nodeId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ nodeId: firecrackerNodeMaintenance.nodeId })
      .from(firecrackerNodeMaintenance)
      .where(eq(firecrackerNodeMaintenance.nodeId, nodeId));
    return !!row;
  }
  async beginNodeDrain(nodeId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(89274315)`);
      await tx
        .insert(firecrackerNodeMaintenance)
        .values({ nodeId, state: 'draining' })
        .onConflictDoUpdate({
          target: firecrackerNodeMaintenance.nodeId,
          set: { state: 'draining', updatedAt: sql`now()` },
        });
    });
  }
  async endNodeDrain(nodeId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(89274315)`);
      await tx
        .delete(firecrackerNodeMaintenance)
        .where(eq(firecrackerNodeMaintenance.nodeId, nodeId));
    });
  }
  async listNodeEnvironments(nodeId: string): Promise<EnvironmentRecord[]> {
    const rows = await this.db
      .select()
      .from(assistantEnvironments)
      .where(eq(assistantEnvironments.nodeId, nodeId));
    return rows.map((row) => environmentRecordSchema.parse(row));
  }
  async transition(
    record: EnvironmentRecord,
    state: EnvironmentRecord['state'],
    expectedState?: EnvironmentRecord['state'],
  ): Promise<EnvironmentRecord> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(assistantEnvironments)
        .set({ state })
        .where(
          and(
            eq(assistantEnvironments.id, record.id),
            eq(assistantEnvironments.generation, record.generation),
            ...(expectedState ? [eq(assistantEnvironments.state, expectedState)] : []),
          ),
        )
        .returning();
      if (!row) {
        if (expectedState) {
          const [current] = await tx
            .select()
            .from(assistantEnvironments)
            .where(
              and(
                eq(assistantEnvironments.id, record.id),
                eq(assistantEnvironments.generation, record.generation),
              ),
            );
          if (current) return environmentRecordSchema.parse(current);
        }
        throw new Error('Environment generation changed');
      }
      const result = environmentRecordSchema.parse(row);
      if (state !== record.state)
        await tx.insert(environmentEvents).values({
          id: randomUUID(),
          environmentId: record.id,
          type: 'transition',
          snapshot: result,
        });
      return result;
    });
  }
}
