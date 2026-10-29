import { metrics } from '@opentelemetry/api';

/**
 * WebRTC media-plane telemetry (docs/webrtc-media-design.md). Same rules as
 * speech-telemetry.ts: GLOBAL meter (no-op without an SDK) and bounded,
 * low-cardinality attributes only — never user/session/media-session ids.
 */

const meter = metrics.getMeter('trinity-harness/server-media');

/** Signaling WebSocket connections currently open. */
export const mediaConnections = meter.createUpDownCounter('trinity.media.connections', {
  description: 'Open media signaling WebSocket connections',
  unit: '{connection}',
});

/** Media sessions currently allocated at the gateway. */
export const mediaSessions = meter.createUpDownCounter('trinity.media.sessions', {
  description: 'Allocated media sessions',
  unit: '{session}',
});

/** Media tokens issued. */
export const mediaTokensIssued = meter.createCounter('trinity.media.tokens_issued', {
  description: 'Short-lived media tokens issued',
  unit: '{token}',
});

/** Signaling/session errors by error code. */
export const mediaErrors = meter.createCounter('trinity.media.errors', {
  description: 'Media-plane errors by code',
  unit: '{error}',
});

/** Media session wall-clock lifetime. */
export const mediaSessionSeconds = meter.createHistogram('trinity.media.session_seconds', {
  description: 'Media session lifetime',
  unit: 's',
});
