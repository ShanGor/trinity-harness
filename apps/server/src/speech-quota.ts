/**
 * In-process per-tenant speech quota meter (docs/voice-call-design.md §8.4).
 *
 * The server is the single authenticated entry point for both batch
 * `/api/speech/*` routes and the streaming ASR WebSocket proxy, so a
 * process-local sliding-window meter is sufficient and deterministic (no
 * cross-replica coordination is required for the current single-server
 * deployment; a Redis-backed implementation can replace this behind the same
 * call sites later). Windows are sliding (not calendar-aligned) so bursts
 * decay immediately; fail-closed semantics live at the call site: when the
 * meter cannot run there is nothing to enforce, and when quota configuration
 * cannot be read the caller denies the request (AGENTS.md §3.4).
 *
 * Meter state must never leak into metrics: only bounded outcome counters are
 * exported (see speech-telemetry.ts).
 */

/** Speech quota fields of the tenant quota row (packages/contracts usage.ts). */
export interface SpeechQuotaConfig {
  concurrentAsrStreams?: number | undefined;
  concurrentTtsStreams?: number | undefined;
  /** WebRTC media sessions (docs/webrtc-media-design.md §5). */
  concurrentMediaSessions?: number | undefined;
  hourlyAsrBytes?: number | undefined;
  hourlyTtsCharacters?: number | undefined;
  speechRequestsPerMinute?: number | undefined;
}

export type SpeechLeaseKind = 'asr_stream' | 'tts_stream' | 'media_session';

/**
 * Handle for an admitted concurrency slot. Releasing is idempotent; leases
 * are freed automatically when their owning meter is garbage-collected is NOT
 * relied upon — every admission path pairs with an explicit release.
 */
export interface SpeechLease {
  readonly kind: SpeechLeaseKind;
  readonly tenantId: string;
  release(): void;
  /** True once the slot has been returned (idempotent release). */
  readonly released: boolean;
}

interface TenantBucket {
  /** Request timestamps within the sliding minute window. */
  minute: number[];
  /** Per-request amounts within the sliding hour window. */
  hour: { t: number; asrBytes: number; ttsChars: number }[];
  asrStreams: Set<SpeechLease>;
  ttsStreams: Set<SpeechLease>;
  mediaSessions: Set<SpeechLease>;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;

export class SpeechQuotaMeter {
  private readonly buckets = new Map<string, TenantBucket>();

  constructor(private readonly now: () => number = Date.now) {}

  /**
   * Sliding-window request-rate admission. Records the request even when no
   * limit is configured so later-tightened limits apply immediately.
   */
  admitRequest(tenantId: string, cfg: SpeechQuotaConfig): boolean {
    const bucket = this.bucket(tenantId);
    const t = this.now();
    prune(bucket, t, MINUTE_MS, HOUR_MS);
    bucket.minute.push(t);
    const limit = cfg.speechRequestsPerMinute;
    return limit === undefined || bucket.minute.length <= limit;
  }

  /**
   * Hourly ASR audio byte admission (batch uploads and streaming chunks).
   * Denied amounts are NOT recorded — a rejected request must not keep the
   * window saturated (unlike request-rate denial, which does count attempts).
   */
  admitAsrBytes(tenantId: string, bytes: number, cfg: SpeechQuotaConfig): boolean {
    const bucket = this.bucket(tenantId);
    const t = this.now();
    prune(bucket, t, MINUTE_MS, HOUR_MS);
    const limit = cfg.hourlyAsrBytes;
    if (limit !== undefined && sum(bucket.hour, (e) => e.asrBytes) + bytes > limit) {
      return false;
    }
    bucket.hour.push({ t, asrBytes: bytes, ttsChars: 0 });
    return true;
  }

  /** Hourly TTS character admission; caller holds the stream lease separately. */
  admitTtsCharacters(tenantId: string, chars: number, cfg: SpeechQuotaConfig): boolean {
    const bucket = this.bucket(tenantId);
    const t = this.now();
    prune(bucket, t, MINUTE_MS, HOUR_MS);
    const limit = cfg.hourlyTtsCharacters;
    if (limit !== undefined && sum(bucket.hour, (e) => e.ttsChars) + chars > limit) {
      return false;
    }
    bucket.hour.push({ t, asrBytes: 0, ttsChars: chars });
    return true;
  }

  /** Concurrency admission for one streaming ASR connection. */
  admitAsrStream(tenantId: string, cfg: SpeechQuotaConfig): SpeechLease | null {
    return this.admitStream(tenantId, cfg.concurrentAsrStreams, 'asr_stream');
  }

  /** Concurrency admission for one TTS synthesis stream. */
  admitTtsStream(tenantId: string, cfg: SpeechQuotaConfig): SpeechLease | null {
    return this.admitStream(tenantId, cfg.concurrentTtsStreams, 'tts_stream');
  }

  /** Concurrency admission for one WebRTC media session (gateway adapter). */
  admitMediaSession(tenantId: string, cfg: SpeechQuotaConfig): SpeechLease | null {
    return this.admitStream(tenantId, cfg.concurrentMediaSessions, 'media_session');
  }

  activeStreams(tenantId: string, kind: SpeechLeaseKind): number {
    const bucket = this.buckets.get(tenantId);
    if (!bucket) return 0;
    return this.streamSet(bucket, kind).size;
  }

  private admitStream(
    tenantId: string,
    limit: number | undefined,
    kind: SpeechLeaseKind,
  ): SpeechLease | null {
    const bucket = this.bucket(tenantId);
    const t = this.now();
    prune(bucket, t, MINUTE_MS, HOUR_MS);
    const set = this.streamSet(bucket, kind);
    if (limit !== undefined && set.size >= limit) return null;
    let released = false;
    const lease: SpeechLease = {
      kind,
      tenantId,
      get released() {
        return released;
      },
      release: () => {
        if (released) return;
        released = true;
        set.delete(lease);
      },
    };
    set.add(lease);
    return lease;
  }

  private streamSet(bucket: TenantBucket, kind: SpeechLeaseKind): Set<SpeechLease> {
    switch (kind) {
      case 'asr_stream':
        return bucket.asrStreams;
      case 'tts_stream':
        return bucket.ttsStreams;
      case 'media_session':
        return bucket.mediaSessions;
    }
  }

  private bucket(tenantId: string): TenantBucket {
    let bucket = this.buckets.get(tenantId);
    if (!bucket) {
      bucket = {
        minute: [],
        hour: [],
        asrStreams: new Set(),
        ttsStreams: new Set(),
        mediaSessions: new Set(),
      };
      this.buckets.set(tenantId, bucket);
    }
    return bucket;
  }
}

function prune(bucket: TenantBucket, t: number, minuteMs: number, hourMs: number): void {
  if (bucket.minute.length > 0 && t - bucket.minute[0]! > minuteMs) {
    bucket.minute = bucket.minute.filter((at) => t - at <= minuteMs);
  }
  if (bucket.hour.length > 0 && t - bucket.hour[0]!.t > hourMs) {
    bucket.hour = bucket.hour.filter((e) => t - e.t <= hourMs);
  }
}

function sum(
  events: { t: number; asrBytes: number; ttsChars: number }[],
  pick: (e: { t: number; asrBytes: number; ttsChars: number }) => number,
): number {
  let total = 0;
  for (const e of events) total += pick(e);
  return total;
}
