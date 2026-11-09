import { DEFAULT_SPEECH_PREFERENCES } from '@trinity-harness/shared';
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChatItem } from '../src/chat-items.js';
import {
  VoiceCallController,
  type VoiceCallDependencies,
  type VoiceCallPlayer,
} from '../src/voice-call-controller.js';

class FakeTrack {
  enabled = true;
  stopped = false;
  stop(): void {
    this.stopped = true;
  }
}

class FakeStream {
  readonly tracks = [new FakeTrack()];
  getTracks(): FakeTrack[] {
    return this.tracks;
  }
  getAudioTracks(): FakeTrack[] {
    return this.tracks;
  }
}

class FakeMediaRecorder extends EventTarget {
  static instances: FakeMediaRecorder[] = [];
  static isTypeSupported(): boolean {
    return true;
  }
  readonly mimeType = 'audio/webm;codecs=opus';
  state: RecordingState = 'inactive';
  emitAudio = true;
  deferStop = false;

  constructor(readonly stream: FakeStream) {
    super();
    FakeMediaRecorder.instances.push(this);
  }

  start(): void {
    this.state = 'recording';
  }

  stop(): void {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    if (!this.deferStop) this.emitStop();
  }

  emitStop(): void {
    if (this.emitAudio) {
      const data = new Event('dataavailable');
      Object.defineProperty(data, 'data', { value: new Blob(['voice'], { type: this.mimeType }) });
      this.dispatchEvent(data);
    }
    this.dispatchEvent(new Event('stop'));
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  static inputLevel = 128;
  readonly sampleRate = 24_000;
  state: AudioContextState = 'suspended';

  constructor() {
    FakeAudioContext.instances.push(this);
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async close(): Promise<void> {
    this.state = 'closed';
  }

  createMediaStreamSource(): { connect(): void; disconnect(): void } {
    return { connect: () => undefined, disconnect: () => undefined };
  }

  createAnalyser(): {
    fftSize: number;
    getByteTimeDomainData(levels: Uint8Array): void;
    disconnect(): void;
  } {
    return {
      fftSize: 32,
      getByteTimeDomainData: (levels) => levels.fill(FakeAudioContext.inputLevel),
      disconnect: () => undefined,
    };
  }
}

class FakePlayer implements VoiceCallPlayer {
  readonly sampleRate = 24_000;
  readonly chunks: Uint8Array[] = [];
  stopped = false;

  constructor(private readonly onEnded: () => void) {}

  async resume(): Promise<void> {}
  append(chunk: Uint8Array): void {
    if (!this.stopped) this.chunks.push(chunk);
  }
  finish(): void {
    this.onEnded();
  }
  stop(): void {
    this.stopped = true;
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: Error): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function audioStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 0]));
      controller.close();
    },
  });
}

function responseItems(content: string, final: boolean, transcript = 'Hello Trinity'): ChatItem[] {
  return [
    {
      key: 'user',
      messageId: 'prompt-1',
      role: 'user',
      content: transcript,
      streaming: false,
      tools: [],
      attachments: [],
    },
    {
      key: 'assistant',
      role: 'assistant',
      content,
      streaming: !final,
      final,
      tools: [],
      attachments: [],
    },
  ];
}

function setup(overrides: Partial<VoiceCallDependencies> = {}): {
  controller: VoiceCallController;
  deps: VoiceCallDependencies;
  players: FakePlayer[];
  session: { id: string | null };
} {
  const session = { id: 'session-a' as string | null };
  const players: FakePlayer[] = [];
  const deps: VoiceCallDependencies = {
    getSessionId: () => session.id,
    submit: vi.fn(async (_text: string, onPromptId: (promptId: string) => void) => {
      onPromptId('prompt-1');
      return true;
    }),
    cancelTurn: vi.fn(async () => true),
    onError: vi.fn(),
    transcribe: vi.fn(async () => 'Hello Trinity'),
    synthesize: vi.fn(async () => ({ sampleRate: 24_000, stream: audioStream() })),
    createPlayer: (_rate, onEnded) => {
      const player = new FakePlayer(onEnded);
      players.push(player);
      return player;
    },
    ...overrides,
  };
  return { controller: new VoiceCallController(deps), deps, players, session };
}

/** Controllable streaming-ASR session double for controller tests. */
interface FakeStreaming {
  session: {
    resume: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    finish: ReturnType<typeof vi.fn>;
    active: boolean;
  };
  handlers: {
    onSpeechActivity: () => void;
    onPartial: (text: string) => void;
    onFinal: (text: string) => void;
    onError: (message: string) => void;
    onEnd: (reason: string) => void;
  };
}

function fakeStreaming(): FakeStreaming {
  const handlers = {
    onSpeechActivity: (): void => undefined,
    onPartial: (): void => undefined,
    onFinal: (): void => undefined,
    onError: (): void => undefined,
    onEnd: (): void => undefined,
  };
  const session = {
    resume: vi.fn(),
    pause: vi.fn(),
    finish: vi.fn(),
    active: true,
  };
  return { session, handlers };
}

function setupStreaming(): {
  controller: VoiceCallController;
  deps: VoiceCallDependencies;
  players: FakePlayer[];
  streaming: FakeStreaming;
} {
  const streaming = fakeStreaming();
  const base = setup({
    startStreamingAsr: vi.fn(async (h) => {
      Object.assign(streaming.handlers, h);
      return streaming.session;
    }),
  });
  return { ...base, streaming };
}

/** Both media modes faked; lets tests assert WebRTC precedence and fallback. */
function setupDualMode(): {
  controller: VoiceCallController;
  deps: VoiceCallDependencies;
  webrtc: FakeStreaming;
  streaming: FakeStreaming;
} {
  const webrtc = fakeStreaming();
  const streaming = fakeStreaming();
  const base = setup({
    startWebRtcAsr: vi.fn(async (_sessionId: string, h: typeof webrtc.handlers) => {
      Object.assign(webrtc.handlers, h);
      return webrtc.session;
    }),
    startStreamingAsr: vi.fn(async (h) => {
      Object.assign(streaming.handlers, h);
      return streaming.session;
    }),
  });
  return { ...base, webrtc, streaming };
}

/** A WebRTC session may expose RTP downlink, but phone playback must not use it. */
interface FakeDownlink {
  speak: ReturnType<typeof vi.fn>;
  stopSpeaking: ReturnType<typeof vi.fn>;
}

function setupWebRtcDownlink(): {
  controller: VoiceCallController;
  deps: VoiceCallDependencies;
  players: FakePlayer[];
  webrtc: FakeStreaming;
  downlink: FakeDownlink;
} {
  const webrtc = fakeStreaming();
  const downlink: FakeDownlink = {
    speak: vi.fn(async () => undefined),
    stopSpeaking: vi.fn(),
  };
  const base = setup({
    startWebRtcAsr: vi.fn(async (_sessionId: string, h: typeof webrtc.handlers) => {
      Object.assign(webrtc.handlers, h);
      return { ...webrtc.session, downlink };
    }),
  });
  return { ...base, webrtc, downlink };
}

let mediaDevicesDescriptor: PropertyDescriptor | undefined;
let secureContextDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  FakeAudioContext.instances = [];
  FakeAudioContext.inputLevel = 128;
  mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  secureContextDescriptor = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => new FakeStream()) },
  });
  vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
  vi.stubGlobal('AudioContext', FakeAudioContext);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (mediaDevicesDescriptor) {
    Object.defineProperty(navigator, 'mediaDevices', mediaDevicesDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'mediaDevices');
  }
  if (secureContextDescriptor) {
    Object.defineProperty(window, 'isSecureContext', secureContextDescriptor);
  }
});

describe('VoiceCallController', () => {
  it('defaults each call to brief and snapshots depth only when submitting a new request', async () => {
    const { controller, deps } = setup();
    await controller.start();
    expect(controller.getSnapshot().depth).toBe('brief');
    controller.setDepth('detailed');
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() =>
      expect(deps.submit).toHaveBeenCalledWith('Hello Trinity', expect.any(Function), {
        mode: 'phone',
        depth: 'detailed',
      }),
    );
    controller.setDepth('brief');
    expect(deps.submit).toHaveBeenCalledOnce();
    controller.stop();
    await controller.start();
    expect(controller.getSnapshot().depth).toBe('brief');
    controller.stop();
  });

  it('applies playback backpressure to a long answer and preserves every sentence through archival', async () => {
    const ended: (() => void)[] = [];
    const { controller, deps } = setup({
      createPlayer: (_rate, onEnded) => {
        ended.push(onEnded);
        return {
          sampleRate: 24000,
          resume: async () => undefined,
          append: () => undefined,
          finish: () => undefined,
          stop: () => undefined,
        };
      },
    });
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
    const sentences = Array.from({ length: 40 }, (_, i) => `Sentence ${i} complete.`);
    const text = sentences.join(' ');
    controller.update(responseItems(text, false), true, false);
    await vi.waitFor(() => expect(deps.synthesize).toHaveBeenCalledOnce());
    const archived = responseItems('', false);
    archived[1]!.activity = [{ content: text }];
    controller.update(archived, true, false);
    controller.update(responseItems('Done.', true), false, false);
    expect(deps.synthesize).toHaveBeenCalledOnce();
    for (let i = 0; i < sentences.length; i += 1) {
      ended[i]!();
      await vi.waitFor(() => expect(deps.synthesize).toHaveBeenCalledTimes(i + 2));
    }
    expect(vi.mocked(deps.synthesize).mock.calls.map(([text]) => text)).toEqual([
      ...sentences,
      'Done.',
    ]);
    ended.at(-1)!();
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
    expect(deps.submit).toHaveBeenCalledOnce();
    controller.stop();
  });

  it('keeps a batch utterance open across a sub-second pause and stops after the longer silence window', async () => {
    vi.useFakeTimers();
    const { controller, deps } = setup();
    await controller.start();
    const recorder = FakeMediaRecorder.instances[0]!;
    FakeAudioContext.inputLevel = 255;
    await vi.advanceTimersByTimeAsync(160);
    FakeAudioContext.inputLevel = 128;
    await vi.advanceTimersByTimeAsync(900);
    expect(recorder.state).toBe('recording');
    expect(deps.transcribe).not.toHaveBeenCalled();
    FakeAudioContext.inputLevel = 255;
    await vi.advanceTimersByTimeAsync(160);
    FakeAudioContext.inputLevel = 128;
    await vi.advanceTimersByTimeAsync(1900);
    expect(deps.transcribe).toHaveBeenCalledOnce();
    expect(deps.submit).toHaveBeenCalledOnce();
    controller.stop();
  });

  it('lets explicit finish transcribe batch speech immediately while ignoring an empty recording', async () => {
    vi.useFakeTimers();
    const { controller, deps } = setup();
    await controller.start();
    controller.finishUtterance();
    expect(deps.transcribe).not.toHaveBeenCalled();
    FakeAudioContext.inputLevel = 255;
    controller.finishUtterance();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.transcribe).toHaveBeenCalledOnce();
    expect(deps.submit).toHaveBeenCalledOnce();
    controller.stop();
  });

  it('discards repeated silent batch recordings locally and still accepts the next spoken turn', async () => {
    vi.useFakeTimers();
    const { controller, deps } = setup();
    await controller.start();
    await vi.advanceTimersByTimeAsync(180_000);
    expect(FakeMediaRecorder.instances).toHaveLength(4);
    expect(FakeMediaRecorder.instances.slice(0, -1).every((r) => r.state === 'inactive')).toBe(
      true,
    );
    expect(controller.getSnapshot().status).toBe('listening');
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
    FakeAudioContext.inputLevel = 255;
    await vi.advanceTimersByTimeAsync(160);
    FakeAudioContext.inputLevel = 128;
    await vi.advanceTimersByTimeAsync(1900);
    expect(deps.transcribe).toHaveBeenCalledOnce();
    expect(deps.submit).toHaveBeenCalledOnce();
    controller.stop();
  });

  it('does not start a second recorder during the asynchronous stop-event window', async () => {
    vi.useFakeTimers();
    const { controller, deps } = setup();
    await controller.start();
    const recorder = FakeMediaRecorder.instances[0]!;
    recorder.deferStop = true;
    FakeAudioContext.inputLevel = 255;
    await vi.advanceTimersByTimeAsync(160);
    FakeAudioContext.inputLevel = 128;
    await vi.advanceTimersByTimeAsync(1900);

    expect(recorder.state).toBe('inactive');
    controller.update([], false, false);
    expect(FakeMediaRecorder.instances).toHaveLength(1);

    recorder.emitStop();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.transcribe).toHaveBeenCalledOnce();
    expect(deps.submit).toHaveBeenCalledOnce();
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    controller.stop();
  });

  it.each(['batch', 'streaming', 'webrtc'] as const)(
    'automatically listens for a clarification answer after playback in %s mode',
    async (mode) => {
      vi.useFakeTimers();
      const { controller, deps, streaming, webrtc } = setupDualMode();
      if (mode !== 'webrtc') deps.startWebRtcAsr = vi.fn(async () => null);
      if (mode === 'batch') deps.startStreamingAsr = vi.fn(async () => null);
      const media = mode === 'streaming' ? streaming : webrtc;
      let endPlayback!: () => void;
      deps.createPlayer = (_rate, onEnded) => {
        endPlayback = onEnded;
        return {
          sampleRate: 24_000,
          resume: async () => undefined,
          append: () => undefined,
          finish: () => undefined,
          stop: () => undefined,
        };
      };
      deps.transcribe = vi
        .fn()
        .mockResolvedValueOnce('RAG 和微调该选哪个')
        .mockResolvedValueOnce('知识经常更新');
      let promptCount = 0;
      deps.submit = vi.fn(async (_text, onPromptId) => {
        onPromptId(`prompt-${++promptCount}`);
        return true;
      });
      await controller.start();
      if (mode === 'batch') FakeMediaRecorder.instances.at(-1)!.stop();
      else {
        media.handlers.onSpeechActivity();
        media.handlers.onFinal('RAG 和微调该选哪个');
      }
      await vi.advanceTimersByTimeAsync(1800);
      expect(deps.submit).toHaveBeenCalledOnce();
      const resumes = media.session.resume.mock.calls.length;
      const recorders = FakeMediaRecorder.instances.length;
      controller.update(
        responseItems('你们主要想更新知识，还是调整回答方式？', true, 'RAG 和微调该选哪个'),
        false,
        false,
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.getSnapshot().status).toBe('speaking');
      expect(media.session.resume).toHaveBeenCalledTimes(resumes);
      expect(FakeMediaRecorder.instances).toHaveLength(recorders);
      endPlayback();
      await vi.advanceTimersByTimeAsync(0);
      expect(controller.getSnapshot().status).toBe('listening');
      if (mode === 'batch') expect(FakeMediaRecorder.instances).toHaveLength(recorders + 1);
      else expect(media.session.resume).toHaveBeenCalledTimes(resumes + 1);
      // Silence does not create a continuation prompt or another answer.
      await vi.advanceTimersByTimeAsync(60_000);
      expect(deps.submit).toHaveBeenCalledOnce();
      if (mode === 'batch') FakeMediaRecorder.instances.at(-1)!.stop();
      else {
        media.handlers.onSpeechActivity();
        media.handlers.onFinal('知识经常更新');
      }
      await vi.advanceTimersByTimeAsync(1800);
      expect(deps.submit).toHaveBeenLastCalledWith('知识经常更新', expect.any(Function), {
        mode: 'phone',
        depth: 'brief',
      });
      expect(deps.submit).toHaveBeenCalledTimes(2);
      controller.stop();
    },
  );

  it.each(['busy', 'approval', 'mute', 'hangup'] as const)(
    'keeps automatic listening fenced by %s after clarification playback',
    async (gate) => {
      vi.useFakeTimers();
      const { controller, deps, streaming } = setupStreaming();
      let endPlayback!: () => void;
      deps.createPlayer = (_rate, onEnded) => {
        endPlayback = onEnded;
        return {
          sampleRate: 24_000,
          resume: async () => undefined,
          append: () => undefined,
          finish: () => undefined,
          stop: () => undefined,
        };
      };
      await controller.start();
      streaming.handlers.onSpeechActivity();
      streaming.handlers.onFinal('Hello Trinity');
      await vi.advanceTimersByTimeAsync(1800);
      const resumes = streaming.session.resume.mock.calls.length;
      const items = responseItems('你希望先了解哪个部分？', true);
      controller.update(items, gate === 'busy', gate === 'approval');
      await vi.advanceTimersByTimeAsync(0);
      if (gate === 'mute') controller.toggleMute();
      if (gate === 'hangup') controller.stop();
      endPlayback();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(streaming.session.resume).toHaveBeenCalledTimes(resumes);
      expect(deps.submit).toHaveBeenCalledOnce();
      expect(deps.cancelTurn).not.toHaveBeenCalled();

      if (gate === 'hangup') {
        controller.update(items, false, false);
        expect(controller.getSnapshot().active).toBe(false);
        expect(streaming.session.resume).toHaveBeenCalledTimes(resumes);
      } else {
        if (gate === 'mute') controller.toggleMute();
        else controller.update(items, false, false);
        expect(controller.getSnapshot().status).toBe('listening');
        expect(streaming.session.resume).toHaveBeenCalledTimes(resumes + 1);
      }
      controller.stop();
    },
  );

  it('runs a complete turn and speaks stable sentences before resuming listening', async () => {
    const saved = { voiceStyle: '标准普通话，沉稳温柔的成年女声，耐心自然。' };
    const getSpeechPreferences = vi.fn(async () => ({ ...saved }));
    const { controller, deps, players } = setup({ getSpeechPreferences });
    await controller.start();
    expect(controller.getSnapshot().status).toBe('listening');

    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() =>
      expect(deps.submit).toHaveBeenCalledWith('Hello Trinity', expect.any(Function), {
        mode: 'phone',
        depth: 'brief',
      }),
    );

    controller.update(responseItems('First sentence. Second', false), true, false);
    await vi.waitFor(() =>
      expect(deps.synthesize).toHaveBeenCalledWith('First sentence.', expect.anything(), {
        voiceStyle: '标准普通话，沉稳温柔的成年女声，耐心自然。',
      }),
    );
    expect(controller.getSnapshot().status).toBe('thinking');

    saved.voiceStyle = '清晰自然的成年男声';
    controller.update(responseItems('First sentence. Second sentence.', true), false, false);
    await vi.waitFor(() => expect(deps.synthesize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));

    expect(deps.synthesize).toHaveBeenNthCalledWith(2, 'Second sentence.', expect.anything(), {
      voiceStyle: '标准普通话，沉稳温柔的成年女声，耐心自然。',
    });
    expect(getSpeechPreferences).toHaveBeenCalledOnce();
    expect(players).toHaveLength(2);
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    expect(deps.cancelTurn).not.toHaveBeenCalled();
    controller.stop();
  });

  it('waits for a Markdown link to close instead of speaking a partial URL', async () => {
    const { controller, deps } = setup();
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());

    controller.update(responseItems('[Hello](https://example.', false), true, false);
    await Promise.resolve();
    expect(deps.synthesize).not.toHaveBeenCalled();

    controller.update(responseItems('[Hello](https://example.com)', true), false, false);
    await vi.waitFor(() =>
      expect(deps.synthesize).toHaveBeenCalledWith(
        'Hello',
        expect.anything(),
        DEFAULT_SPEECH_PREFERENCES,
      ),
    );
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
    controller.stop();
  });

  it('does not repeat stable prose when streaming emphasis closes later', async () => {
    const { controller, deps } = setup();
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());

    controller.update(responseItems('First sentence. **Bold statement.', false), true, false);
    await vi.waitFor(() =>
      expect(deps.synthesize).toHaveBeenCalledWith(
        'First sentence.',
        expect.anything(),
        DEFAULT_SPEECH_PREFERENCES,
      ),
    );
    controller.update(responseItems('First sentence. **Bold statement.**', true), false, false);

    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
    expect(vi.mocked(deps.synthesize).mock.calls.map(([text]) => text)).toEqual([
      'First sentence.',
      'Bold statement.',
    ]);
    controller.stop();
  });

  it('reveals only started audio, bounds captions, and fences callbacks after interruption', async () => {
    const starts: (() => void)[] = [];
    const ends: (() => void)[] = [];
    const { controller, deps } = setup({
      createPlayer: (_rate, ended, _context, started) => {
        starts.push(started);
        ends.push(ended);
        const player = new FakePlayer(ended);
        player.finish = () => undefined;
        return player;
      },
    });
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
    const content = 'First. Second. Third. Fourth. Fifth.';
    controller.update(responseItems(content, true), false, false);
    await vi.waitFor(() => expect(deps.synthesize).toHaveBeenCalledTimes(1));
    expect(controller.getSnapshot().assistantText).toBe(content);
    expect(controller.getSnapshot().captions).toEqual([]);
    for (let index = 0; index < 4; index += 1) {
      await vi.waitFor(() => expect(starts).toHaveLength(index + 1));
      starts[index]!();
      starts[index]!(); // A duplicated callback cannot duplicate a caption.
      expect(controller.getSnapshot().captions.map(({ text }) => text)).toEqual(
        ['First.', 'Second.', 'Third.', 'Fourth.'].slice(Math.max(0, index - 2), index + 1),
      );
      ends[index]!();
    }
    await vi.waitFor(() => expect(starts).toHaveLength(5));
    const captions = controller.getSnapshot().captions;
    await controller.interrupt();
    starts[4]!();
    expect(controller.getSnapshot().captions).toEqual(captions);
    controller.stop();
    starts[4]!();
    expect(controller.getSnapshot().captions).toEqual([]);
  });

  it('keeps raw details and ordinary punctuation while excluding structured citations from TTS', async () => {
    const { controller, deps } = setup();
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());

    const content = 'Use C++ and C#. Ground Truth Reference is **visible**.';
    const items = responseItems(content, true);
    items[1]!.citationList = [
      {
        kind: 'web_source',
        label: 'Display-only citation',
        url: 'https://example.com/evidence',
        callId: 'call-1',
        evidenceSeq: 1,
      },
    ];
    controller.update(items, false, false);

    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
    expect(deps.synthesize).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.synthesize).mock.calls.map(([text]) => text)).toEqual([
      'Use C++ and C#.',
      'Ground Truth Reference is visible.',
    ]);
    expect(controller.getSnapshot().assistantText).toBe(content);
    controller.stop();
  });

  it('uses the current Chinese question as the language hint for a numeric answer', async () => {
    const { controller, deps } = setup({ transcribe: vi.fn(async () => '十九乘十九是多少？') });
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
    controller.update(responseItems('361', true), false, false);
    await vi.waitFor(() =>
      expect(deps.synthesize).toHaveBeenCalledWith(
        '361',
        expect.anything(),
        DEFAULT_SPEECH_PREFERENCES,
        'Chinese',
      ),
    );
    controller.stop();
  });

  it('does not speak copied conversation source metadata in a streamed answer', async () => {
    const { controller, deps } = setup();
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());

    const answer = '三百六十一（19 × 19 = 361）。';
    const source =
      '[Conversation source eventId=01a19bc9-9a41-7000-8c1f-4b8bc9c1e1d7, seq=41, characters 0-19/19]';
    controller.update(responseItems(`${answer}\n[Conversation source`, false), true, false);
    await vi.waitFor(() => expect(deps.synthesize).toHaveBeenCalledTimes(1));
    controller.update(responseItems(`${answer}\n${source}`, true), false, false);

    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
    expect(vi.mocked(deps.synthesize).mock.calls.map(([text]) => text)).toEqual([answer]);
    expect(controller.getSnapshot().assistantText).toBe(`${answer}\n${source}`);
    controller.stop();
  });

  it('continues with the final answer when a tool archive interrupts provisional speech', async () => {
    const firstSynthesis = deferred<{
      sampleRate: number;
      stream: ReadableStream<Uint8Array>;
    }>();
    const { controller, deps, players } = setup({
      synthesize: vi.fn((text: string) =>
        text === 'Working on it.'
          ? firstSynthesis.promise
          : Promise.resolve({ sampleRate: 24_000, stream: audioStream() }),
      ),
    });
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
    controller.update(responseItems('Working on it.', false), true, false);
    await vi.waitFor(() => expect(deps.synthesize).toHaveBeenCalledTimes(1));

    const archived = responseItems('', false);
    archived[1]!.activity = [{ content: 'Working on it.' }];
    controller.update(archived, true, false);
    expect(players[0]!.stopped).toBe(false);
    controller.update(responseItems('Final answer.', true), false, false);
    firstSynthesis.resolve({ sampleRate: 24_000, stream: audioStream() });

    await vi.waitFor(() => expect(deps.synthesize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
    expect(deps.synthesize).toHaveBeenNthCalledWith(
      2,
      'Final answer.',
      expect.anything(),
      DEFAULT_SPEECH_PREFERENCES,
    );
    controller.stop();
  });

  it('speaks localized waiting hints during subtasks and lets the final answer follow', async () => {
    vi.useFakeTimers();
    const transcript = '请调研这个问题';
    const statusText = '子任务还在处理中，结果汇总后我会继续。';
    const statusSynthesis = deferred<{
      sampleRate: number;
      stream: ReadableStream<Uint8Array>;
    }>();
    const { controller, deps } = setup({
      transcribe: vi.fn(async () => transcript),
      synthesize: vi.fn((text: string) =>
        text === statusText
          ? statusSynthesis.promise
          : Promise.resolve({ sampleRate: 24_000, stream: audioStream() }),
      ),
    });
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.submit).toHaveBeenCalledWith(transcript, expect.any(Function), {
      mode: 'phone',
      depth: 'brief',
    });

    controller.update(responseItems('我先查一下资料。', false, transcript), true, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.synthesize).toHaveBeenCalledWith(
      '我先查一下资料。',
      expect.anything(),
      DEFAULT_SPEECH_PREFERENCES,
    );

    const researching = responseItems('', false, transcript);
    researching[1]!.activity = [
      { content: '我先查一下资料。' },
      { content: 'Subagent 1234: running; Strategy: do not read this' },
    ];
    researching[1]!.tools = [
      {
        toolCallId: 'subagent-1',
        title: 'subagent({"task":"private research arguments"})',
        status: 'in_progress',
      },
    ];
    controller.update(researching, true, false);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(deps.synthesize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(deps.synthesize).toHaveBeenNthCalledWith(
      2,
      statusText,
      expect.anything(),
      DEFAULT_SPEECH_PREFERENCES,
    );

    controller.update(responseItems('最终答案。', true, transcript), false, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.synthesize).toHaveBeenCalledTimes(2);
    statusSynthesis.resolve({ sampleRate: 24_000, stream: audioStream() });
    await vi.advanceTimersByTimeAsync(0);

    expect(deps.synthesize).toHaveBeenNthCalledWith(
      3,
      '最终答案。',
      expect.anything(),
      DEFAULT_SPEECH_PREFERENCES,
    );
    expect(controller.getSnapshot().status).toBe('listening');
    await vi.advanceTimersByTimeAsync(45_000);
    expect(deps.synthesize).toHaveBeenCalledTimes(3);
    controller.stop();
  });

  it('still speaks the final answer when an in-flight waiting hint fails', async () => {
    vi.useFakeTimers();
    const synthesis = deferred<{ sampleRate: number; stream: ReadableStream<Uint8Array> }>();
    const { controller, deps } = setup({
      synthesize: vi.fn((text: string) =>
        text === 'Final answer.'
          ? Promise.resolve({ sampleRate: 24_000, stream: audioStream() })
          : synthesis.promise,
      ),
    });
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.advanceTimersByTimeAsync(0);
    controller.update(responseItems('', false), true, false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.synthesize).toHaveBeenCalledOnce();

    controller.update(responseItems('Final answer.', true), false, false);
    synthesis.reject(new Error('Waiting hint failed'));
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.synthesize).toHaveBeenLastCalledWith(
      'Final answer.',
      expect.anything(),
      DEFAULT_SPEECH_PREFERENCES,
    );
    expect(controller.getSnapshot().status).toBe('listening');
    controller.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('suppresses waiting hints during approval and clears them on hangup', async () => {
    vi.useFakeTimers();
    const { controller, deps } = setup();
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.advanceTimersByTimeAsync(0);
    const waiting = responseItems('', false);
    controller.update(waiting, true, false);
    await vi.advanceTimersByTimeAsync(9_000);
    controller.update(waiting, true, true);
    await vi.advanceTimersByTimeAsync(46_000);
    expect(deps.synthesize).not.toHaveBeenCalled();
    controller.update(waiting, true, false);
    controller.stop();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(deps.synthesize).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('discards a waiting hint that resolves after approval starts', async () => {
    vi.useFakeTimers();
    const synthesis = deferred<{ sampleRate: number; stream: ReadableStream<Uint8Array> }>();
    const { controller, deps, players } = setup({
      synthesize: vi.fn((text: string) =>
        text === 'Final answer.'
          ? Promise.resolve({ sampleRate: 24_000, stream: audioStream() })
          : synthesis.promise,
      ),
    });
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.advanceTimersByTimeAsync(0);
    const waiting = responseItems('', false);
    controller.update(waiting, true, false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deps.synthesize).toHaveBeenCalledOnce();
    controller.update(waiting, true, true);
    synthesis.resolve({ sampleRate: 24_000, stream: audioStream() });
    await vi.advanceTimersByTimeAsync(0);
    expect(players[0]!.stopped).toBe(true);
    expect(players[0]!.chunks).toHaveLength(0);
    controller.update(responseItems('Final answer.', true), false, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.synthesize).toHaveBeenLastCalledWith(
      'Final answer.',
      expect.anything(),
      DEFAULT_SPEECH_PREFERENCES,
    );
    expect(controller.getSnapshot().status).toBe('listening');
    controller.stop();
  });

  it('spaces out and alternates English research reminders', async () => {
    vi.useFakeTimers();
    const { controller, deps } = setup();
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(deps.submit).toHaveBeenCalledOnce();

    const researching = responseItems('', false);
    researching[1]!.tools = [
      {
        toolCallId: 'browser-1',
        title: 'browser({"operation":"web_search"})',
        status: 'in_progress',
      },
    ];
    controller.update(researching, true, false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(vi.mocked(deps.synthesize).mock.calls.map(([text]) => text)).toEqual([
      'Research is still in progress. I’ll continue when there’s an update.',
    ]);

    await vi.advanceTimersByTimeAsync(44_999);
    expect(deps.synthesize).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(vi.mocked(deps.synthesize).mock.calls.map(([text]) => text)).toEqual([
      'Research is still in progress. I’ll continue when there’s an update.',
      'The research is still running. I’ll report back when it’s ready.',
    ]);
    controller.update(responseItems('Done.', true), false, false);
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().status).toBe('listening');
    controller.stop();
  });

  it('returns to listening without submitting when the recorder produces no audio', async () => {
    const { controller, deps } = setup();
    await controller.start();
    FakeMediaRecorder.instances[0]!.emitAudio = false;
    FakeMediaRecorder.instances[0]!.stop();

    await vi.waitFor(() => expect(FakeMediaRecorder.instances).toHaveLength(2));
    expect(controller.getSnapshot().status).toBe('listening');
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
    controller.stop();
  });

  it('invalidates queued and in-flight speech when the response is removed', async () => {
    const firstSynthesis = deferred<{
      sampleRate: number;
      stream: ReadableStream<Uint8Array>;
    }>();
    const { controller, deps, players } = setup({
      synthesize: vi.fn(() => firstSynthesis.promise),
    });
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
    controller.update(responseItems('First. Second.', false), true, false);
    await vi.waitFor(() => expect(deps.synthesize).toHaveBeenCalledTimes(1));

    const removed = responseItems('First. Second.', false);
    removed[1]!.removed = true;
    controller.update(removed, true, false);
    firstSynthesis.resolve({ sampleRate: 24_000, stream: audioStream() });
    controller.update(removed, false, false);

    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
    expect(deps.synthesize).toHaveBeenCalledTimes(1);
    expect(players[0]!.chunks).toHaveLength(0);
    expect(controller.getSnapshot().assistantText).toBe('');
    controller.stop();
  });

  it('uses promptId after historical reprojection instead of an older same-text exchange', async () => {
    const { controller, deps } = setup();
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
    const reprojected = responseItems('', false);
    reprojected[0]!.key = 'new-user-key';
    reprojected[1]!.key = 'new-assistant-key';
    const historical = responseItems('Old answer.', true);
    historical[0]!.key = 'old-user-key';
    historical[0]!.messageId = 'old-prompt';
    historical[1]!.key = 'old-assistant-key';

    controller.update([...historical, ...reprojected], true, false);
    expect(deps.synthesize).not.toHaveBeenCalled();
    const current = responseItems('New answer.', true);
    current[0]!.key = 'new-user-key';
    current[1]!.key = 'new-assistant-key';
    controller.update([...historical, ...current], false, false);

    await vi.waitFor(() =>
      expect(deps.synthesize).toHaveBeenCalledWith(
        'New answer.',
        expect.anything(),
        DEFAULT_SPEECH_PREFERENCES,
      ),
    );
    expect(deps.synthesize).not.toHaveBeenCalledWith(
      'Old answer.',
      expect.anything(),
      DEFAULT_SPEECH_PREFERENCES,
    );
    controller.stop();
  });

  it('does not submit a late ASR result after hangup or into a new call', async () => {
    const firstAsr = deferred<string>();
    const { controller, deps } = setup({ transcribe: vi.fn(() => firstAsr.promise) });
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('transcribing'));

    controller.stop();
    await controller.start();
    firstAsr.resolve('Must not be sent');
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.submit).not.toHaveBeenCalled();
    expect(controller.getSnapshot().userText).toBe('');
    expect(controller.getSnapshot().status).toBe('listening');
    controller.stop();
  });

  it('fences late TTS audio after interruption and requests ordinary cancellation', async () => {
    const synthesis = deferred<{ sampleRate: number; stream: ReadableStream<Uint8Array> }>();
    const { controller, deps, players } = setup({ synthesize: vi.fn(() => synthesis.promise) });
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
    controller.update(responseItems('First sentence.', false), true, false);
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('speaking'));

    const interrupting = controller.interrupt();
    controller.update(responseItems('First sentence.', false), false, false);
    await interrupting;
    synthesis.resolve({ sampleRate: 24_000, stream: audioStream() });
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.cancelTurn).toHaveBeenCalledOnce();
    expect(players[0]!.chunks).toHaveLength(0);
    expect(controller.getSnapshot().status).toBe('listening');
    controller.stop();
  });

  it('cancels an in-flight submission after settlement and waits for the terminal event', async () => {
    const submission = deferred<boolean | void>();
    const { controller, deps } = setup({
      submit: vi.fn((_text: string, onPromptId: (promptId: string) => void) => {
        onPromptId('prompt-1');
        return submission.promise;
      }),
      cancelTurn: vi.fn(async () => false),
    });
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());

    await controller.interrupt();
    expect(deps.cancelTurn).not.toHaveBeenCalled();
    expect(FakeMediaRecorder.instances).toHaveLength(1);

    submission.resolve(true);
    await vi.waitFor(() => expect(deps.cancelTurn).toHaveBeenCalledOnce());
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    expect(controller.getSnapshot().status).toBe('thinking');

    controller.onTurnTerminal('session-a', 'another-prompt');
    expect(controller.getSnapshot().status).toBe('thinking');
    expect(FakeMediaRecorder.instances).toHaveLength(1);
    controller.onTurnTerminal('session-a', 'prompt-1');
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
    expect(FakeMediaRecorder.instances).toHaveLength(2);
    controller.stop();
  });

  it('surfaces submission failure instead of waiting forever when a New session has nothing to cancel', async () => {
    const submission = deferred<boolean | void>();
    const { controller, deps, session } = setup({
      submit: vi.fn(() => submission.promise),
      cancelTurn: vi.fn(async () => false),
    });
    session.id = null;
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
    await controller.interrupt();

    submission.resolve(false);
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('error'));

    expect(controller.getSnapshot().error).toContain('was not sent');
    expect(deps.cancelTurn).not.toHaveBeenCalled();
    expect(controller.getSnapshot().active).toBe(true);
    controller.stop();
  });

  it('drops an in-flight utterance on mute and never treats hangup as Agent cancellation', async () => {
    const recognition = deferred<string>();
    const { controller, deps } = setup({ transcribe: vi.fn(() => recognition.promise) });
    await controller.start();
    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('transcribing'));

    controller.toggleMute();
    recognition.resolve('Stale speech');
    await Promise.resolve();
    await Promise.resolve();
    expect(deps.submit).not.toHaveBeenCalled();
    expect(controller.getSnapshot().muted).toBe(true);

    controller.stop();
    expect(deps.cancelTurn).not.toHaveBeenCalled();
  });

  it('stops when its bound session changes instead of accepting another session projection', async () => {
    const { controller, session } = setup();
    await controller.start();
    session.id = 'session-b';
    controller.update([], false, false);

    expect(controller.getSnapshot().active).toBe(false);
    expect(FakeMediaRecorder.instances[0]!.state).toBe('inactive');
  });

  describe('streaming ASR mode (docs/voice-call-design.md §8.1)', () => {
    beforeEach(() => vi.useFakeTimers());
    it.each(['streaming', 'webrtc'] as const)(
      'merges continued speech on %s without pausing the microphone at a segment final',
      async (mode) => {
        const { controller, deps, streaming, webrtc } = setupDualMode();
        if (mode === 'streaming') deps.startWebRtcAsr = vi.fn(async () => null);
        const media = mode === 'streaming' ? streaming : webrtc;
        await controller.start();
        media.session.pause.mockClear();
        media.handlers.onSpeechActivity();
        await vi.advanceTimersByTimeAsync(700);
        media.handlers.onFinal('我想找一部电影');
        expect(media.session.pause).not.toHaveBeenCalled();
        expect(controller.getSnapshot().status).toBe('listening');
        await vi.advanceTimersByTimeAsync(200);
        media.handlers.onSpeechActivity();
        media.handlers.onPartial('最好是');
        expect(controller.getSnapshot().userText).toBe('我想找一部电影 最好是');
        await vi.advanceTimersByTimeAsync(1000);
        expect(deps.submit).not.toHaveBeenCalled();
        expect(media.session.pause).not.toHaveBeenCalled();
        media.handlers.onFinal('最好是喜剧');
        await vi.advanceTimersByTimeAsync(799);
        expect(deps.submit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1);
        expect(deps.submit).toHaveBeenCalledExactlyOnceWith(
          '我想找一部电影 最好是喜剧',
          expect.any(Function),
          { mode: 'phone', depth: 'brief' },
        );
        expect(media.session.pause).toHaveBeenCalledOnce();
        controller.stop();
      },
    );

    it.each([false, true])(
      'recovers when speech produces no recognition text (manual=%s)',
      async (manual) => {
        const { controller, deps, streaming } = setupStreaming();
        await controller.start();
        streaming.handlers.onSpeechActivity();
        if (manual) controller.finishUtterance();
        await vi.advanceTimersByTimeAsync(5801);
        expect(deps.submit).not.toHaveBeenCalled();
        expect(streaming.session.finish).toHaveBeenCalled();
        expect(controller.getSnapshot().status).toBe('listening');
        streaming.handlers.onFinal('迟到的旧结果');
        expect(deps.submit).not.toHaveBeenCalled();
        FakeAudioContext.inputLevel = 150;
        controller.finishUtterance();
        await vi.advanceTimersByTimeAsync(0);
        expect(deps.transcribe).toHaveBeenCalled();
        expect(deps.submit).toHaveBeenCalledOnce();
        controller.stop();
      },
    );

    it('does not add another silence window after a delayed ASR final', async () => {
      const { controller, deps, streaming } = setupStreaming();
      await controller.start();
      streaming.handlers.onSpeechActivity();
      streaming.handlers.onPartial('推荐一部');
      await vi.advanceTimersByTimeAsync(1900);
      expect(deps.submit).not.toHaveBeenCalled();
      streaming.handlers.onFinal('推荐一部喜剧');
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.submit).toHaveBeenCalledExactlyOnceWith('推荐一部喜剧', expect.any(Function), {
        mode: 'phone',
        depth: 'brief',
      });
      controller.stop();
    });

    it('keeps listening to progressing recognition when quiet speech never crosses the local energy gate', async () => {
      const { controller, deps, streaming } = setupStreaming();
      await controller.start();
      for (const partial of ['我在', '我在慢慢', '我在慢慢说明这个问题']) {
        streaming.handlers.onPartial(partial);
        await vi.advanceTimersByTimeAsync(3000);
        expect(controller.getSnapshot().status).toBe('listening');
      }
      streaming.handlers.onFinal('我在慢慢说明这个问题');
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.submit).toHaveBeenCalledExactlyOnceWith(
        '我在慢慢说明这个问题',
        expect.any(Function),
        { mode: 'phone', depth: 'brief' },
      );
      controller.stop();
    });

    it('waits for recognition of the continuation even after the local silence deadline', async () => {
      const { controller, deps, streaming } = setupStreaming();
      await controller.start();
      streaming.handlers.onSpeechActivity();
      streaming.handlers.onFinal('第一段');
      await vi.advanceTimersByTimeAsync(800);
      streaming.handlers.onSpeechActivity();
      streaming.handlers.onPartial('第二');
      await vi.advanceTimersByTimeAsync(2000);
      expect(deps.submit).not.toHaveBeenCalled();
      streaming.handlers.onFinal('第二段');
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.submit).toHaveBeenCalledExactlyOnceWith('第一段 第二段', expect.any(Function), {
        mode: 'phone',
        depth: 'brief',
      });
      controller.stop();
    });

    it.each(['mute', 'interrupt', 'hangup', 'session', 'approval', 'busy', 'asr-end'] as const)(
      'discards an unsubmitted streaming turn on %s',
      async (action) => {
        const { controller, deps, streaming } = setupStreaming();
        await controller.start();
        streaming.handlers.onSpeechActivity();
        streaming.handlers.onFinal('未提交的第一段');
        if (action === 'mute') controller.toggleMute();
        if (action === 'interrupt') await controller.interrupt();
        if (action === 'hangup') controller.stop();
        if (action === 'session') {
          deps.getSessionId = () => 'another-session';
          controller.update([], false, false);
        }
        if (action === 'approval') controller.update([], false, true);
        if (action === 'busy') controller.update([], true, false);
        if (action === 'asr-end') streaming.handlers.onEnd('closed');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(deps.submit).not.toHaveBeenCalled();
        controller.stop();
      },
    );

    it('supports explicit finish while never submitting a provisional transcript', async () => {
      const { controller, deps, streaming } = setupStreaming();
      await controller.start();
      streaming.handlers.onSpeechActivity();
      streaming.handlers.onPartial('还没确认');
      controller.finishUtterance();
      controller.finishUtterance();
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.submit).not.toHaveBeenCalled();
      streaming.handlers.onFinal('确认后的全文');
      await vi.advanceTimersByTimeAsync(0);
      expect(deps.submit).toHaveBeenCalledExactlyOnceWith('确认后的全文', expect.any(Function), {
        mode: 'phone',
        depth: 'brief',
      });
      controller.stop();
    });

    it('falls back to batch rather than submitting stale segments when a continuation final never arrives', async () => {
      const { controller, deps, streaming } = setupStreaming();
      await controller.start();
      streaming.handlers.onSpeechActivity();
      streaming.handlers.onFinal('已确认');
      streaming.handlers.onSpeechActivity();
      streaming.handlers.onPartial('未确认');
      await vi.advanceTimersByTimeAsync(5801);
      expect(deps.submit).not.toHaveBeenCalled();
      expect(controller.getSnapshot().status).toBe('listening');
      expect(streaming.session.finish).toHaveBeenCalled();
      expect(deps.onError).toHaveBeenCalledWith(expect.stringContaining('Please repeat'));
      controller.stop();
    });
    it('drives a full turn from VAD final to spoken answer and back to listening', async () => {
      const { controller, deps, players, streaming } = setupStreaming();
      await controller.start();
      expect(streaming.session.resume).toHaveBeenCalled();
      expect(FakeMediaRecorder.instances).toHaveLength(1); // discarded silent pre-roll
      expect(FakeMediaRecorder.instances[0]!.state).toBe('inactive');
      expect(deps.transcribe).not.toHaveBeenCalled();

      streaming.handlers.onPartial('Hello Trin');
      expect(controller.getSnapshot().userText).toBe('Hello Trin');

      streaming.handlers.onFinal('Hello Trinity');
      await vi.advanceTimersByTimeAsync(1800);
      await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
      controller.update(responseItems('Hi there.', true), false, false);
      await vi.waitFor(() =>
        expect(deps.synthesize).toHaveBeenCalledWith(
          'Hi there.',
          expect.anything(),
          DEFAULT_SPEECH_PREFERENCES,
        ),
      );
      await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
      // Capture paused while the answer played, then resumed.
      expect(streaming.session.pause).toHaveBeenCalled();
      expect(streaming.session.resume).toHaveBeenCalledTimes(2);
      expect(players).toHaveLength(1);
      controller.stop();
    });

    it('drops late finals after interruption and fences them by streamEpoch', async () => {
      const { controller, deps, streaming } = setupStreaming();
      await controller.start();
      streaming.handlers.onFinal('First question');
      await vi.advanceTimersByTimeAsync(1800);
      await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
      controller.update(responseItems('First answer.', false), true, false);
      await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('speaking'));

      await controller.interrupt();
      streaming.handlers.onFinal('Late utterance');
      expect(deps.submit).toHaveBeenCalledOnce();

      controller.update([], false, false);
      await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
      streaming.handlers.onFinal('Second question');
      await vi.advanceTimersByTimeAsync(1800);
      await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledTimes(2));
      controller.stop();
    });

    it('mute pauses capture and fences finals while muted; unmute resumes', async () => {
      const { controller, deps, streaming } = setupStreaming();
      await controller.start();
      controller.toggleMute();
      expect(streaming.session.pause).toHaveBeenCalled();
      streaming.handlers.onFinal('spoken while muted');
      expect(deps.submit).not.toHaveBeenCalled();

      controller.toggleMute();
      expect(streaming.session.resume).toHaveBeenCalledTimes(2);
      streaming.handlers.onFinal('Second question');
      await vi.advanceTimersByTimeAsync(1800);
      await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
      controller.stop();
    });

    it.each([0, 160])(
      'preserves the whole pre-roll utterance when ready after %i ms',
      async (delay) => {
        vi.useFakeTimers();
        const streaming = fakeStreaming();
        const connection = deferred<FakeStreaming['session']>();
        const { controller, deps } = setup({
          startStreamingAsr: vi.fn(async (handlers) => {
            Object.assign(streaming.handlers, handlers);
            return connection.promise;
          }),
        });

        const starting = controller.start();
        await vi.advanceTimersByTimeAsync(0);
        expect(FakeMediaRecorder.instances).toHaveLength(1);
        expect(FakeMediaRecorder.instances[0]!.state).toBe('recording');
        expect(deps.startStreamingAsr).toHaveBeenCalledOnce();

        FakeAudioContext.inputLevel = 255;
        await vi.advanceTimersByTimeAsync(delay);
        connection.resolve(streaming.session);
        await starting;
        expect(FakeMediaRecorder.instances[0]!.state).toBe('recording');
        expect(deps.transcribe).not.toHaveBeenCalled();
        expect(streaming.session.resume).not.toHaveBeenCalled();
        streaming.handlers.onFinal('Duplicate realtime pre-roll');
        expect(deps.submit).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(deps.transcribe).not.toHaveBeenCalled();

        FakeAudioContext.inputLevel = 128;
        await vi.advanceTimersByTimeAsync(1_900);
        await vi.advanceTimersByTimeAsync(0);

        expect(deps.transcribe).toHaveBeenCalledOnce();
        expect(deps.submit).toHaveBeenCalledWith('Hello Trinity', expect.any(Function), {
          mode: 'phone',
          depth: 'brief',
        });
        expect(streaming.session.pause).toHaveBeenCalled();
        expect(streaming.session.resume).not.toHaveBeenCalled();
        controller.stop();
      },
    );

    it.each(['webrtc', 'streaming'] as const)(
      'disposes a late %s connection after hangup',
      async (mode) => {
        vi.useFakeTimers();
        const streaming = fakeStreaming();
        const connection = deferred<FakeStreaming['session']>();
        const { controller, deps } = setup({
          ...(mode === 'webrtc'
            ? { startWebRtcAsr: vi.fn(() => connection.promise) }
            : { startStreamingAsr: vi.fn(() => connection.promise) }),
        });
        const starting = controller.start();
        await vi.advanceTimersByTimeAsync(0);
        const recorder = FakeMediaRecorder.instances[0]!;
        controller.stop();
        connection.resolve(streaming.session);
        await starting;

        expect(streaming.session.finish).toHaveBeenCalledOnce();
        expect(streaming.session.resume).not.toHaveBeenCalled();
        expect(recorder.stream.tracks[0]!.stopped).toBe(true);
        expect(deps.transcribe).not.toHaveBeenCalled();
        expect(deps.submit).not.toHaveBeenCalled();
        expect(controller.getSnapshot().active).toBe(false);
        expect(vi.getTimerCount()).toBe(0);
      },
    );

    it('does not open a fallback connection after hangup during WebRTC setup', async () => {
      vi.useFakeTimers();
      const connection = deferred<null>();
      const { controller, deps } = setup({
        startWebRtcAsr: vi.fn(() => connection.promise),
        startStreamingAsr: vi.fn(async () => null),
      });
      const starting = controller.start();
      await vi.advanceTimersByTimeAsync(0);
      controller.stop();
      connection.resolve(null);
      await starting;
      expect(deps.startStreamingAsr).not.toHaveBeenCalled();
    });

    it('releases late microphone permission without starting a connection', async () => {
      vi.useFakeTimers();
      const microphone = deferred<MediaStream>();
      vi.mocked(navigator.mediaDevices.getUserMedia).mockReturnValue(microphone.promise);
      const { controller, deps } = setup({ startStreamingAsr: vi.fn(async () => null) });
      const starting = controller.start();
      await vi.advanceTimersByTimeAsync(0);
      controller.stop();
      const stream = new FakeStream();
      microphone.resolve(stream as unknown as MediaStream);
      await starting;
      expect(stream.tracks[0]!.stopped).toBe(true);
      expect(deps.startStreamingAsr).not.toHaveBeenCalled();
      expect(FakeMediaRecorder.instances).toHaveLength(0);
    });

    it('does not open realtime connections when microphone permission is denied', async () => {
      vi.mocked(navigator.mediaDevices.getUserMedia).mockRejectedValue(
        new Error('Permission denied'),
      );
      const { controller, deps } = setup({ startStreamingAsr: vi.fn(async () => null) });
      await controller.start();
      expect(controller.getSnapshot().status).toBe('error');
      expect(deps.startStreamingAsr).not.toHaveBeenCalled();
      expect(FakeMediaRecorder.instances).toHaveLength(0);
      expect(FakeAudioContext.instances[0]!.state).toBe('closed');
      controller.stop();
    });

    it('finishes the streaming session on hangup and ignores late finals', async () => {
      const { controller, deps, streaming } = setupStreaming();
      await controller.start();
      controller.stop();
      expect(streaming.session.finish).toHaveBeenCalled();
      streaming.handlers.onFinal('Too late');
      expect(deps.submit).not.toHaveBeenCalled();
      expect(controller.getSnapshot().active).toBe(false);
    });

    it('unexpected recognizer end fails the call into a reconnectable error', async () => {
      const { controller, deps, streaming } = setupStreaming();
      await controller.start();
      streaming.handlers.onEnd('upstream closed');
      await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('error'));
      expect(streaming.session.finish).toHaveBeenCalled();
      expect(deps.onError).not.toHaveBeenCalled();
      expect(controller.getSnapshot().active).toBe(true);
      controller.stop();
    });

    it('falls back to the batch recorder path when streaming is unavailable', async () => {
      const { controller, deps } = setup({
        startStreamingAsr: vi.fn(async () => null),
      });
      await controller.start();
      expect(FakeMediaRecorder.instances).toHaveLength(1);
      FakeMediaRecorder.instances[0]!.stop();
      await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
      controller.stop();
    });

    it('prefers WebRTC media uplink over streaming ASR (docs/webrtc-media-design.md)', async () => {
      const { controller, deps, webrtc, streaming } = setupDualMode();
      await controller.start();
      expect(deps.startWebRtcAsr).toHaveBeenCalledWith('session-a', expect.anything());
      expect(deps.startStreamingAsr).not.toHaveBeenCalled();
      expect(webrtc.session.resume).toHaveBeenCalled();
      expect(streaming.session.resume).not.toHaveBeenCalled();

      webrtc.handlers.onPartial('hello');
      expect(controller.getSnapshot().userText).toBe('hello');
      webrtc.handlers.onFinal('Hello Trinity');
      await vi.advanceTimersByTimeAsync(1800);
      await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
      controller.stop();
      expect(webrtc.session.finish).toHaveBeenCalled();
    });

    it('falls back to streaming ASR when WebRTC is unavailable', async () => {
      const { controller, deps, webrtc, streaming } = setupDualMode();
      // Simulate an unconfigured media plane (501 on /api/media/token).
      deps.startWebRtcAsr = vi.fn(async () => null);
      await controller.start();
      expect(webrtc.session.resume).not.toHaveBeenCalled();
      expect(streaming.session.resume).toHaveBeenCalled();

      streaming.handlers.onFinal('Hello Trinity');
      await vi.advanceTimersByTimeAsync(1800);
      await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
      controller.stop();
    });

    it('skips WebRTC when no session is bound yet (New draft)', async () => {
      const { controller, deps, webrtc, streaming, session } = setupDualMode();
      session.id = null;
      await controller.start();
      expect(deps.startWebRtcAsr).not.toHaveBeenCalled();
      expect(webrtc.session.resume).not.toHaveBeenCalled();
      expect(streaming.session.resume).toHaveBeenCalled();
      controller.stop();
    });

    it('keeps WebRTC for ASR but always plays replies through SSE TTS and PCM', async () => {
      const { controller, deps, players, webrtc, downlink } = setupWebRtcDownlink();
      await controller.start();
      webrtc.handlers.onFinal('Hello Trinity');
      await vi.advanceTimersByTimeAsync(1800);
      await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
      controller.update(responseItems('Hi there.', true), false, false);

      await vi.waitFor(() =>
        expect(deps.synthesize).toHaveBeenCalledWith(
          'Hi there.',
          expect.anything(),
          DEFAULT_SPEECH_PREFERENCES,
        ),
      );
      expect(downlink.speak).not.toHaveBeenCalled();
      expect(players).toHaveLength(1);
      await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
      expect(webrtc.session.resume).toHaveBeenCalledTimes(2); // capture resumed after speech
      controller.stop();
    });
  });
});
