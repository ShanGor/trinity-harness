import { describe, expect, it } from 'vitest';

import { SpeechQuotaMeter, type SpeechQuotaConfig } from '../src/speech-quota.js';

/** Deterministic clock: advance manually in tests. */
function makeClock(start = 1_000_000_000_000) {
  let now = start;
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const T = 'tenant-a';
const unlimited: SpeechQuotaConfig = {};

describe('SpeechQuotaMeter', () => {
  it('admits everything when no limits are configured', () => {
    const meter = new SpeechQuotaMeter(makeClock().now);
    for (let i = 0; i < 100; i += 1) expect(meter.admitRequest(T, unlimited)).toBe(true);
    expect(meter.admitAsrBytes(T, 10_000_000, unlimited)).toBe(true);
    expect(meter.admitTtsCharacters(T, 1_000_000, unlimited)).toBe(true);
    expect(meter.admitAsrStream(T, unlimited)).not.toBeNull();
    expect(meter.admitTtsStream(T, unlimited)).not.toBeNull();
  });

  it('enforces the sliding per-minute request rate and decays after the window', () => {
    const clock = makeClock();
    const meter = new SpeechQuotaMeter(clock.now);
    const cfg: SpeechQuotaConfig = { speechRequestsPerMinute: 3 };
    expect(meter.admitRequest(T, cfg)).toBe(true);
    expect(meter.admitRequest(T, cfg)).toBe(true);
    expect(meter.admitRequest(T, cfg)).toBe(true);
    expect(meter.admitRequest(T, cfg)).toBe(false);
    clock.advance(61_000);
    expect(meter.admitRequest(T, cfg)).toBe(true);
  });

  it('counts denied rate attempts but never denies for quota-free tenants', () => {
    const meter = new SpeechQuotaMeter(makeClock().now);
    const cfg: SpeechQuotaConfig = { speechRequestsPerMinute: 1 };
    expect(meter.admitRequest(T, cfg)).toBe(true);
    expect(meter.admitRequest(T, cfg)).toBe(false); // denied attempts still count
    expect(meter.admitRequest('tenant-b', unlimited)).toBe(true);
  });

  it('enforces hourly ASR bytes without recording denied amounts', () => {
    const clock = makeClock();
    const meter = new SpeechQuotaMeter(clock.now);
    const cfg: SpeechQuotaConfig = { hourlyAsrBytes: 1000 };
    expect(meter.admitAsrBytes(T, 600, cfg)).toBe(true);
    expect(meter.admitAsrBytes(T, 600, cfg)).toBe(false); // would exceed; not recorded
    expect(meter.admitAsrBytes(T, 400, cfg)).toBe(true); // 600+400=1000 fits
    expect(meter.admitAsrBytes(T, 1, cfg)).toBe(false);
    clock.advance(3_600_001);
    expect(meter.admitAsrBytes(T, 1000, cfg)).toBe(true);
  });

  it('enforces hourly TTS characters independently of ASR bytes', () => {
    const clock = makeClock();
    const meter = new SpeechQuotaMeter(clock.now);
    const cfg: SpeechQuotaConfig = { hourlyAsrBytes: 100, hourlyTtsCharacters: 50 };
    expect(meter.admitAsrBytes(T, 100, cfg)).toBe(true);
    expect(meter.admitTtsCharacters(T, 50, cfg)).toBe(true);
    expect(meter.admitTtsCharacters(T, 1, cfg)).toBe(false);
    clock.advance(3_600_001);
    expect(meter.admitTtsCharacters(T, 50, cfg)).toBe(true);
  });

  it('enforces concurrent stream limits per tenant and releases slots idempotently', () => {
    const meter = new SpeechQuotaMeter(makeClock().now);
    const cfg: SpeechQuotaConfig = { concurrentTtsStreams: 2, concurrentAsrStreams: 1 };
    const tts1 = meter.admitTtsStream(T, cfg);
    const tts2 = meter.admitTtsStream(T, cfg);
    expect(tts1).not.toBeNull();
    expect(tts2).not.toBeNull();
    expect(meter.admitTtsStream(T, cfg)).toBeNull();
    const asr1 = meter.admitAsrStream(T, cfg);
    expect(asr1).not.toBeNull();
    expect(meter.admitAsrStream(T, cfg)).toBeNull();
    // Other tenant unaffected.
    expect(meter.admitAsrStream('tenant-b', cfg)).not.toBeNull();

    tts1!.release();
    tts1!.release(); // idempotent
    expect(tts1!.released).toBe(true);
    expect(meter.activeStreams(T, 'tts_stream')).toBe(1);
    const tts3 = meter.admitTtsStream(T, cfg);
    expect(tts3).not.toBeNull();
    expect(meter.activeStreams(T, 'tts_stream')).toBe(2);
  });

  it('admits WebRTC media sessions under their own tenant limit (docs/webrtc-media-design.md §5)', () => {
    const meter = new SpeechQuotaMeter(makeClock().now);
    const cfg: SpeechQuotaConfig = { concurrentMediaSessions: 1 };
    const lease = meter.admitMediaSession(T, cfg);
    expect(lease).not.toBeNull();
    expect(lease!.kind).toBe('media_session');
    expect(meter.admitMediaSession(T, cfg)).toBeNull();
    expect(meter.activeStreams(T, 'media_session')).toBe(1);
    // Speech stream limits do not interfere with media sessions.
    expect(meter.admitAsrStream(T, {})).not.toBeNull();
    lease!.release();
    expect(meter.activeStreams(T, 'media_session')).toBe(0);
    expect(meter.admitMediaSession(T, cfg)).not.toBeNull();
    // Unconfigured tenants are unlimited.
    expect(meter.admitMediaSession('tenant-b', {})).not.toBeNull();
  });
});
