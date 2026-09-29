import type { AuditEmitter, AuditRecord, EventBus } from '@trinity-harness/contracts';

/** Name of the global audit stream (docs/design.md §13/§14). */
export const AUDIT_STREAM = 'audit';

/**
 * Publishes audit records onto the `audit` stream for the independent audit
 * consumer to persist. Fire-and-forget: audit emission must never break the
 * user-facing flow (at-least-once delivery, idempotent insert at the store).
 */
export class BusAuditEmitter implements AuditEmitter {
  constructor(private readonly bus: EventBus) {}

  emit(record: AuditRecord): void {
    void this.bus
      .publish(AUDIT_STREAM, {
        type: 'audit/record',
        payload: record,
        occurredAt: record.at,
      })
      .catch((err) => {
        console.error('[BusAuditEmitter] publish failed', err);
      });
  }
}
