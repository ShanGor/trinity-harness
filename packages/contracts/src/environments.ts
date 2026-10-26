import { z } from 'zod';
import type { Identity } from './identity.js';

export const ENVIRONMENT_MEMORY_OVERHEAD_MIB = 256;

export const environmentStateSchema = z.enum(['stopped', 'starting', 'running', 'quarantined']);
export const environmentRecordSchema = z
  .object({
    id: z.uuid(),
    tenantId: z.uuid(),
    userId: z.uuid(),
    nodeId: z.string().regex(/^[a-z0-9-]{1,63}$/),
    generation: z.uuid(),
    state: environmentStateSchema,
    vcpus: z.number().int().min(1).max(32),
    memoryMiB: z.number().int().min(256).max(65536),
  })
  .strict();
export type EnvironmentRecord = z.infer<typeof environmentRecordSchema>;
export const environmentViewSchema = environmentRecordSchema
  .omit({ tenantId: true, userId: true, nodeId: true, generation: true })
  .strip();
export const environmentResponseSchema = z.object({
  available: z.boolean(),
  environment: environmentViewSchema.nullable(),
});
export const environmentNodeSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9-]{1,63}$/),
    endpoint: z.url().refine((text) => {
      const url = new URL(text);
      return (
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash &&
        url.pathname === '/' &&
        (url.protocol === 'https:' ||
          (url.protocol === 'http:' && ['127.0.0.1', '[::1]'].includes(url.hostname)))
      );
    }),
    vcpus: z.number().int().positive(),
    memoryMiB: z.number().int().positive(),
  })
  .strict();
export type EnvironmentNode = z.infer<typeof environmentNodeSchema>;
export const nodeRuntimeRequestSchema = z
  .object({
    operation: z.enum(['start', 'stop', 'status']),
    environment: environmentRecordSchema,
  })
  .strict();
export const nodeRuntimeResultSchema = z
  .object({
    generation: z.uuid(),
    state: environmentStateSchema,
  })
  .strict();
export type NodeRuntimeResult = z.infer<typeof nodeRuntimeResultSchema>;
export const environmentNodeDrainResultSchema = z
  .object({
    nodeId: z.string().regex(/^[a-z0-9-]{1,63}$/),
    state: z.literal('draining'),
    stopped: z.number().int().nonnegative(),
    remaining: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
  })
  .strict();
export type EnvironmentNodeDrainResult = z.infer<typeof environmentNodeDrainResultSchema>;
export interface NodeRuntimePort {
  command(
    operation: 'start' | 'stop' | 'status',
    environment: EnvironmentRecord,
    signal?: AbortSignal,
  ): Promise<NodeRuntimeResult>;
}
export interface EnvironmentStore {
  run<T>(
    identity: Identity,
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  /** Shared lifecycle lock: parallel guest calls drain before an exclusive stop. */
  runShared<T>(
    identity: Identity,
    action: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T>;
  get(identity: Identity): Promise<EnvironmentRecord | null>;
  /** Capacity admission and a durable generation reservation, never TTL takeover. */
  reserve(identity: Identity, nodes: readonly EnvironmentNode[]): Promise<EnvironmentRecord>;
  authorizeNode(
    record: EnvironmentRecord,
    operation?: 'start' | 'stop' | 'status' | 'guest' | 'guest-complete',
  ): Promise<boolean>;
  isNodeDraining(nodeId: string): Promise<boolean>;
  beginNodeDrain(nodeId: string): Promise<void>;
  endNodeDrain(nodeId: string): Promise<void>;
  listNodeEnvironments(nodeId: string): Promise<EnvironmentRecord[]>;
  transition(
    record: EnvironmentRecord,
    state: EnvironmentRecord['state'],
    /** Status probes retain a concurrent state change rather than overwriting it. */
    expectedState?: EnvironmentRecord['state'],
  ): Promise<EnvironmentRecord>;
}
export interface EnvironmentPort {
  get(identity: Identity, signal?: AbortSignal): Promise<EnvironmentRecord | null>;
  wake(identity: Identity, signal?: AbortSignal): Promise<EnvironmentRecord>;
  suspend(identity: Identity, signal?: AbortSignal): Promise<EnvironmentRecord | null>;
}
export interface EnvironmentMaintenancePort {
  drainNode(nodeId: string, signal?: AbortSignal): Promise<EnvironmentNodeDrainResult>;
  resumeNode(nodeId: string): Promise<void>;
}
