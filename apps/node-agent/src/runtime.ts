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
  private async hostCommand(
    executable: string,
    args: string[],
    signal?: AbortSignal,
    timeoutMs = 25_000,
  ): Promise<string> {
    if (!this.sandbox.execArgv) throw new Error('Bounded argv execution required');
    const result = await this.sandbox.execArgv(executable, args, {
      maxOutputBytes: 4096,
      timeoutMs,
      signal,
    });
    if (result.exitCode || result.outputOverflow) throw new Error('Host service operation failed');
    return result.stdout.trim();
  }
  private async systemctl(args: string[], signal?: AbortSignal): Promise<string> {
    return this.hostCommand('/usr/bin/systemctl', args, signal);
  }
  private async unitState(
    unit: string,
    signal?: AbortSignal,
  ): Promise<{ load: string; active: string }> {
    const output = await this.hostCommand(
      '/usr/bin/systemctl',
      ['show', '--property=LoadState', '--property=ActiveState', '--value', unit],
      signal,
    );
    const [load, active, ...extra] = output.split(/\r?\n/);
    if (!load || !active || extra.length > 0) throw new Error('Host service status malformed');
    return { load, active };
  }
  private async configureGuestEgress(
    record: EnvironmentRecord,
    signal?: AbortSignal,
  ): Promise<void> {
    const gateway = await this.unitState('trinity-firecracker-egress.service', signal);
    const dns = await this.unitState('trinity-firecracker-egress-dns.service', signal);
    if (gateway.load === 'not-found' && dns.load === 'not-found') return;
    if (
      gateway.load !== 'loaded' ||
      dns.load !== 'loaded' ||
      gateway.active !== 'active' ||
      dns.active !== 'active'
    )
      throw new Error('Host guest egress gateway is installed but not ready');
    await this.hostCommand(
      '/usr/bin/systemctl',
      ['start', `trinity-firecracker-egress-config@${record.id}.service`],
      signal,
      100_000,
    );
  }
  async command(
    operation: 'start' | 'stop' | 'status',
    input: EnvironmentRecord,
    signal?: AbortSignal,
  ): Promise<NodeRuntimeResult> {
    const record = environmentRecordSchema.parse(input);
    const unit = `trinity-vm@${record.id}-${record.generation}.service`;
    if (operation === 'start') {
      await this.configureGuestEgress(record, signal);
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
