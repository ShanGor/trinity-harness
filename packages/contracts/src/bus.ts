/**
 * Minimal disposable contract (aligned with the platform Disposable so both
 * `dispose()` and `using` work).
 */
export interface Disposable {
  dispose(): void;
  [Symbol.dispose](): void;
}

/** Envelope for events distributed over the global event bus (design.md §14). */
export interface BusEvent {
  type: string;
  payload?: unknown;
  occurredAt: string;
}

/**
 * Global event bus on top of Redis Stream (design.md §14).
 * Redis is a distribution layer only; PG remains the source of truth.
 */
export interface EventBus {
  publish(stream: string, event: BusEvent): Promise<void>;
  subscribe(stream: string, group: string, handler: (event: BusEvent) => Promise<void>): Disposable;
}
