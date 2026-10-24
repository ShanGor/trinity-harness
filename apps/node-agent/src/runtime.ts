import {
  environmentRecordSchema,
  ENVIRONMENT_MEMORY_OVERHEAD_MIB,
  type EnvironmentRecord,
  type NodeRuntimePort,
  type NodeRuntimeResult,
  type SandboxPort,
} from '@trinity-harness/contracts';

/** Fixed systemd template, never a shell or a client-provided executable/path. */
export class SystemdNodeRuntime implements NodeRuntimePort {
  constructor(private readonly sandbox: SandboxPort) {}
  private async systemctl(args: string[], signal?: AbortSignal): Promise<string> {
    if (!this.sandbox.execArgv) throw new Error('Bounded argv execution required');
    const result = await this.sandbox.execArgv('/usr/bin/systemctl', args, {
      maxOutputBytes: 4096,
      timeoutMs: 25_000,
      signal,
    });
    if (result.exitCode || result.outputOverflow) throw new Error('Host service operation failed');
    return result.stdout.trim();
  }
  async command(
    operation: 'start' | 'stop' | 'status',
    input: EnvironmentRecord,
    signal?: AbortSignal,
  ): Promise<NodeRuntimeResult> {
    const record = environmentRecordSchema.parse(input);
    const unit = `trinity-vm@${record.id}-${record.generation}.service`;
    if (operation === 'start') {
      // The operator must provision the encrypted volume and network namespace first.
      // Manifest contains no keys, physical node address or model-originated paths.
      await this.sandbox.writeFile(
        `instances/${record.id}-${record.generation}.json`,
        JSON.stringify(record),
      );
      await this.systemctl(
        [
          'set-property',
          '--runtime',
          unit,
          `MemoryMax=${record.memoryMiB + ENVIRONMENT_MEMORY_OVERHEAD_MIB}M`,
          `CPUQuota=${record.vcpus * 100}%`,
        ],
        signal,
      );
      await this.systemctl(['start', '--no-block', unit], signal);
      return { generation: record.generation, state: 'starting' };
    }
    if (operation === 'stop') {
      await this.systemctl(['stop', unit], signal);
      // A successful synchronous stop is the required confirmation. Transient
      // units may be unloaded immediately afterward, making reset-failed noisy.
      return { generation: record.generation, state: 'stopped' };
    }
    const state = await this.systemctl(['show', '--property=ActiveState', '--value', unit], signal);
    // A running VMM is not a guest/tool readiness or security certification.
    return {
      generation: record.generation,
      state:
        state === 'active'
          ? 'running'
          : ['activating', 'deactivating'].includes(state)
            ? 'starting'
            : state === 'inactive'
              ? 'stopped'
              : 'quarantined',
    };
  }
}
