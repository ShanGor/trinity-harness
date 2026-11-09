/**
 * Streams raw mono PCM16LE chunks into a Web Audio playback graph.
 *
 * The TTS service streams token-decoded audio chunks; AudioBufferSourceNodes
 * are scheduled back-to-back ahead of the playhead so playback is gapless once
 * the first chunk lands.
 */
export class PcmPlayer {
  private readonly context: AudioContext;
  private readonly ownsContext: boolean;
  private nextStartTime = 0;
  /** Odd trailing byte carried over until the next chunk completes the sample. */
  private carry: Uint8Array | null = null;
  private startFrame: number | null = null;
  private started = false;
  private finished = false;
  private stopped = false;
  private readonly sources = new Set<AudioBufferSourceNode>();

  constructor(
    sampleRate: number,
    private readonly onEnded?: () => void,
    context?: AudioContext,
    private readonly onStarted?: () => void,
  ) {
    this.context = context ?? new AudioContext({ sampleRate });
    this.ownsContext = !context;
  }

  get sampleRate(): number {
    return this.context.sampleRate;
  }

  /** Resumes autoplay-suspended audio; call synchronously from a user gesture. */
  async resume(): Promise<void> {
    if (this.stopped) return;
    if (this.context.state !== 'running') await this.context.resume();
    if (this.context.state !== 'running') {
      throw new Error('Audio playback is blocked by the browser. Please click Play again.');
    }
  }

  /** Queues one little-endian signed 16-bit PCM chunk for playback. */
  append(chunk: Uint8Array): void {
    if (this.stopped || this.finished) return;
    const bytes = this.carry && this.carry.length > 0 ? concatBytes(this.carry, chunk) : chunk;
    this.carry = null;
    const frameCount = Math.floor(bytes.length / 2);
    if (frameCount === 0) {
      this.carry = bytes.slice();
      return;
    }
    if (bytes.length % 2 !== 0) this.carry = bytes.subarray(frameCount * 2).slice();
    const buffer = this.context.createBuffer(1, frameCount, this.context.sampleRate);
    const channel = buffer.getChannelData(0);
    const view = new DataView(bytes.buffer, bytes.byteOffset, frameCount * 2);
    for (let i = 0; i < frameCount; i += 1) {
      channel[i] = view.getInt16(i * 2, true) / 0x8000;
    }
    const source = this.context.createBufferSource();
    source.buffer = buffer;
    source.connect(this.context.destination);
    this.nextStartTime = Math.max(this.context.currentTime + 0.02, this.nextStartTime);
    source.start(this.nextStartTime);
    if (!this.started && this.startFrame === null && this.onStarted) {
      const startTime = this.nextStartTime;
      // Follow the audio clock, including a suspended context. A network chunk
      // or successful synthesis alone does not mean playback has begun.
      const observeStart = (): void => {
        this.startFrame = null;
        if (this.stopped) return;
        if (this.context.state === 'running' && this.context.currentTime >= startTime) {
          this.notifyStarted();
        } else {
          this.startFrame = requestAnimationFrame(observeStart);
        }
      };
      this.startFrame = requestAnimationFrame(observeStart);
    }
    this.nextStartTime += buffer.duration;
    this.sources.add(source);
    source.onended = () => {
      // Very short clips can end between animation frames.
      if (!this.stopped) this.notifyStarted();
      source.disconnect();
      this.sources.delete(source);
      this.drainIfDone();
    };
  }

  /** Signals that no more chunks will arrive; onEnded fires once playback drains. */
  finish(): void {
    this.finished = true;
    this.drainIfDone();
  }

  /** Immediately stops playback and releases the AudioContext. */
  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.startFrame !== null) cancelAnimationFrame(this.startFrame);
    this.startFrame = null;
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
        source.disconnect();
      } catch {
        // Already ended sources reject stop(); nothing to clean up.
      }
    }
    this.sources.clear();
    if (this.ownsContext) void this.context.close();
  }

  private notifyStarted(): void {
    if (this.started) return;
    this.started = true;
    if (this.startFrame !== null) cancelAnimationFrame(this.startFrame);
    this.startFrame = null;
    this.onStarted?.();
  }

  private drainIfDone(): void {
    if (this.stopped || !this.finished || this.sources.size > 0) return;
    this.stopped = true;
    if (this.startFrame !== null) cancelAnimationFrame(this.startFrame);
    this.startFrame = null;
    if (this.ownsContext) void this.context.close();
    this.onEnded?.();
  }
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
