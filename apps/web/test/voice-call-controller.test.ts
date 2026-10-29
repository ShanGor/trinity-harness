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
    onPartial: (text: string) => void;
    onFinal: (text: string) => void;
    onError: (message: string) => void;
    onEnd: (reason: string) => void;
  };
}

function fakeStreaming(): FakeStreaming {
  const handlers = {
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
  it('does not start a second recorder during the asynchronous stop-event window', async () => {
    vi.useFakeTimers();
    const { controller, deps } = setup();
    await controller.start();
    const recorder = FakeMediaRecorder.instances[0]!;
    recorder.deferStop = true;
    FakeAudioContext.inputLevel = 255;
    await vi.advanceTimersByTimeAsync(160);
    FakeAudioContext.inputLevel = 128;
    await vi.advanceTimersByTimeAsync(1000);

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

  it('runs a complete turn and speaks stable sentences before resuming listening', async () => {
    const { controller, deps, players } = setup();
    await controller.start();
    expect(controller.getSnapshot().status).toBe('listening');

    FakeMediaRecorder.instances[0]!.stop();
    await vi.waitFor(() =>
      expect(deps.submit).toHaveBeenCalledWith('Hello Trinity', expect.any(Function)),
    );

    controller.update(responseItems('First sentence. Second', false), true, false);
    await vi.waitFor(() =>
      expect(deps.synthesize).toHaveBeenCalledWith('First sentence.', expect.anything()),
    );
    expect(controller.getSnapshot().status).toBe('thinking');

    controller.update(responseItems('First sentence. Second sentence.', true), false, false);
    await vi.waitFor(() => expect(deps.synthesize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));

    expect(deps.synthesize).toHaveBeenNthCalledWith(2, 'Second sentence.', expect.anything());
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
      expect(deps.synthesize).toHaveBeenCalledWith('Hello', expect.anything()),
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
      expect(deps.synthesize).toHaveBeenCalledWith('First sentence.', expect.anything()),
    );
    controller.update(responseItems('First sentence. **Bold statement.**', true), false, false);

    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
    expect(vi.mocked(deps.synthesize).mock.calls.map(([text]) => text)).toEqual([
      'First sentence.',
      'Bold statement.',
    ]);
    controller.stop();
  });

  it('keeps raw captions and ordinary punctuation while excluding structured citations from TTS', async () => {
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

  it('continues with the final answer when a tool archive interrupts provisional speech', async () => {
    const firstSynthesis = deferred<{
      sampleRate: number;
      stream: ReadableStream<Uint8Array>;
    }>();
    const { controller, deps } = setup({
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
    controller.update(responseItems('Final answer.', true), false, false);
    firstSynthesis.resolve({ sampleRate: 24_000, stream: audioStream() });

    await vi.waitFor(() => expect(deps.synthesize).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
    expect(deps.synthesize).toHaveBeenNthCalledWith(2, 'Final answer.', expect.anything());
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
      expect(deps.synthesize).toHaveBeenCalledWith('New answer.', expect.anything()),
    );
    expect(deps.synthesize).not.toHaveBeenCalledWith('Old answer.', expect.anything());
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
    it('drives a full turn from VAD final to spoken answer and back to listening', async () => {
      const { controller, deps, players, streaming } = setupStreaming();
      await controller.start();
      expect(streaming.session.resume).toHaveBeenCalled();
      expect(FakeMediaRecorder.instances).toHaveLength(0); // no batch recorder

      streaming.handlers.onPartial('Hello Trin');
      expect(controller.getSnapshot().userText).toBe('Hello Trin');

      streaming.handlers.onFinal('Hello Trinity');
      await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
      controller.update(responseItems('Hi there.', true), false, false);
      await vi.waitFor(() =>
        expect(deps.synthesize).toHaveBeenCalledWith('Hi there.', expect.anything()),
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
      await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
      controller.update(responseItems('First answer.', false), true, false);
      await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('speaking'));

      await controller.interrupt();
      streaming.handlers.onFinal('Late utterance');
      expect(deps.submit).toHaveBeenCalledOnce();

      controller.update([], false, false);
      await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
      streaming.handlers.onFinal('Second question');
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
      await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
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
      await vi.waitFor(() => expect(deps.submit).toHaveBeenCalledOnce());
      controller.update(responseItems('Hi there.', true), false, false);

      await vi.waitFor(() =>
        expect(deps.synthesize).toHaveBeenCalledWith('Hi there.', expect.anything()),
      );
      expect(downlink.speak).not.toHaveBeenCalled();
      expect(players).toHaveLength(1);
      await vi.waitFor(() => expect(controller.getSnapshot().status).toBe('listening'));
      expect(webrtc.session.resume).toHaveBeenCalledTimes(2); // capture resumed after speech
      controller.stop();
    });
  });
});
