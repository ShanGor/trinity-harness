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
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static resumeLeavesSuspended = false;

  readonly sampleRate: number;
  readonly currentTime = 0;
  readonly destination = {};
  readonly buffers: FakeAudioBuffer[] = [];
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
    return new FakeAudioBufferSource();
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
});
