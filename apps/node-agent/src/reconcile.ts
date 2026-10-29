import type { EnvironmentStore, NodeRuntimePort } from '@trinity-harness/contracts';

/**
 * Boot reconciliation (docs/design.md §21.4): the Node Agent is the single
 * physical owner of the VMs on its host. After a host reboot the VMMs are gone
 * while PostgreSQL may still report 'running'/'starting' for environments
 * assigned to this node. Probing each assigned environment once at startup
 * converges the durable state with reality: a confirmed-dead VM lands on
 * 'stopped' so the next tool call wakes a fresh generation, while an
 * unresponsive runtime fails closed into 'quarantined' exactly like
 * EnvironmentController.get() (controller.ts).
 */
export async function reconcileNodeEnvironments(
  store: Pick<EnvironmentStore, 'listNodeEnvironments' | 'transition'>,
  runtime: Pick<NodeRuntimePort, 'command'>,
  nodeId: string,
): Promise<{ reconciled: number }> {
  const records = await store.listNodeEnvironments(nodeId);
  let reconciled = 0;
  for (const record of records) {
    if (record.state === 'stopped' || record.state === 'quarantined') continue;
    try {
      const result = await runtime.command('status', record);
      const updated = await store.transition(record, result.state, record.state);
      if (updated.state !== record.state) reconciled += 1;
    } catch {
      // The node could not confirm the VM state; fail closed. A failed
      // transition means a concurrent lifecycle change won the generation or
      // expected-state check, which already supersedes this probe.
      await store.transition(record, 'quarantined', record.state).catch(() => {});
    }
  }
  return { reconciled };
}
