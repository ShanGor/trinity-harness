import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { PcmPlayer } from '../src/pcm-player.js';

class FakeAudioBuffer {
  readonly duration: number;
  private readonly data: Float32Array;

  constructor(frameCount: number, sampleRate: number) {
    this.data = new Float32Array(frameCount);
    this.duration = frameCount / sampleRate;
  }

  getChannelData(): Float32Array {
    return this.data;
  }
}

class FakeAudioBufferSource {
  buffer: FakeAudioBuffer | null = null;
  onended: (() => void) | null = null;

  connect(): void {}
  start(): void {}
  stop(): void {}
  disconnect(): void {}
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static resumeLeavesSuspended = false;

  readonly sampleRate: number;
  currentTime = 0;
  readonly destination = {};
  readonly buffers: FakeAudioBuffer[] = [];
  readonly sources: FakeAudioBufferSource[] = [];
  state: AudioContextState = 'suspended';

  constructor(options: { sampleRate: number }) {
    this.sampleRate = options.sampleRate;
    FakeAudioContext.instances.push(this);
  }

  createBuffer(_channels: number, frameCount: number, sampleRate: number): FakeAudioBuffer {
    const buffer = new FakeAudioBuffer(frameCount, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }

  createBufferSource(): FakeAudioBufferSource {
    const source = new FakeAudioBufferSource();
    this.sources.push(source);
    return source;
  }

  async resume(): Promise<void> {
    if (!FakeAudioContext.resumeLeavesSuspended) this.state = 'running';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }
}

function pcm16Le(samples: number[]): Uint8Array {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  samples.forEach((sample, index) => view.setInt16(index * 2, sample, true));
  return bytes;
}

describe('PcmPlayer', () => {
  beforeEach(() => {
    FakeAudioContext.instances = [];
    FakeAudioContext.resumeLeavesSuspended = false;
    vi.stubGlobal('AudioContext', FakeAudioContext);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('decodes signed PCM16LE without flipping negative samples positive', () => {
    const player = new PcmPlayer(24_000);
    const samples = [-32_768, -12_345, -1, 0, 1, 12_345, 32_767];
    const bytes = pcm16Le(samples);

    // Split at an odd byte too, exercising the carry path between network chunks.
    player.append(bytes.subarray(0, 5));
    player.append(bytes.subarray(5));

    const buffers = FakeAudioContext.instances[0]!.buffers;
    const rendered = buffers.flatMap((buffer) => Array.from(buffer.getChannelData(0)));
    expect(rendered).toEqual(
      Array.from(new Float32Array(samples.map((sample) => sample / 0x8000))),
    );
    player.stop();
  });

  it('announces start once at the audio clock and cancels pending observation on stop', async () => {
    let frame: (() => void) | undefined;
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: () => void) => {
        frame = callback;
        return 1;
      }),
    );
    const cancel = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const started = vi.fn();
    const player = new PcmPlayer(24_000, undefined, undefined, started);
    const context = FakeAudioContext.instances[0]!;
    await player.resume();
    player.append(new Uint8Array([1])); // Incomplete sample cannot start speech.
    expect(frame).toBeUndefined();
    player.append(new Uint8Array([0]));
    frame?.();
    expect(started).not.toHaveBeenCalled();
    context.currentTime = 0.03;
    frame?.();
    expect(started).toHaveBeenCalledOnce();
    player.append(pcm16Le([1, 2]));
    expect(started).toHaveBeenCalledOnce();
    player.stop();

    const cancelledStart = vi.fn();
    const cancelled = new PcmPlayer(24_000, undefined, undefined, cancelledStart);
    cancelled.append(pcm16Le([1, 2]));
    cancelled.stop();
    frame?.();
    expect(cancel).toHaveBeenCalled();
    expect(cancelledStart).not.toHaveBeenCalled();
  });

  it('does not announce empty audio and handles clips shorter than an animation frame', () => {
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 1),
    );
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    const emptyStarted = vi.fn();
    const empty = new PcmPlayer(24_000, undefined, undefined, emptyStarted);
    empty.finish();
    expect(emptyStarted).not.toHaveBeenCalled();

    const started = vi.fn();
    const ended = vi.fn();
    const short = new PcmPlayer(24_000, ended, undefined, started);
    short.append(pcm16Le([1]));
    short.finish();
    expect(started).not.toHaveBeenCalled();
    FakeAudioContext.instances[1]!.sources[0]!.onended?.();
    expect(started).toHaveBeenCalledOnce();
    expect(ended).toHaveBeenCalledOnce();
    expect(started.mock.invocationCallOrder[0]).toBeLessThan(ended.mock.invocationCallOrder[0]!);
  });

  it('resumes a suspended context before playback', async () => {
    const player = new PcmPlayer(24_000);
    await player.resume();
    expect(FakeAudioContext.instances[0]!.state).toBe('running');
    player.stop();
  });

  it('reports an autoplay block instead of silently queueing audio', async () => {
    FakeAudioContext.resumeLeavesSuspended = true;
    const player = new PcmPlayer(24_000);
    await expect(player.resume()).rejects.toThrow('Audio playback is blocked');
    player.stop();
  });

  it('leaves a shared call AudioContext open when one speech segment stops', () => {
    const context = new FakeAudioContext({ sampleRate: 24_000 });
    const player = new PcmPlayer(24_000, undefined, context as unknown as AudioContext);

    player.stop();

    expect(context.state).not.toBe('closed');
  });
});
