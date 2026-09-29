import type { AuditRecord, AuditStore, Disposable, EventBus } from '@trinity-harness/contracts';
import { auditRecordSchema } from '@trinity-harness/contracts';

import { AUDIT_STREAM } from '@trinity-harness/redis';

/**
 * Independent audit consumer (docs/design.md §13): consumes the `audit`
 * stream via a consumer group and persists records into `audit_log` (PG).
 * At-least-once delivery; inserts are idempotent (PK conflict = no-op).
 */
export function startAuditConsumer(deps: {
  bus: EventBus;
  store: AuditStore;
  group?: string;
}): Disposable {
  return deps.bus.subscribe(AUDIT_STREAM, deps.group ?? 'audit-consumer', async (event) => {
    if (event.type !== 'audit/record') return;
    const record = auditRecordSchema.parse(event.payload);
    await deps.store.insert([record as AuditRecord]);
  });
}
