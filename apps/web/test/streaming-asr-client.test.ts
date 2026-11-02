// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { startStreamingAsr } from '../src/streaming-asr';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('uses the shared silence window and reports microphone speech only while capturing', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('isSecureContext', true);
  const track = { stop: vi.fn() };
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => ({ getTracks: () => [track] })) },
  });
  const processor = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null as
      ((event: { inputBuffer: { getChannelData(): Float32Array } }) => void) | null,
  };
  const closeContext = vi.fn(async () => undefined);
  vi.stubGlobal(
    'AudioContext',
    class {
      state = 'running';
      sampleRate = 16000;
      close = closeContext;
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
      createScriptProcessor = () => processor;
    },
  );
  const send = vi.fn();
  const close = vi.fn();
  const sockets: { onclose: (() => void) | null }[] = [];
  vi.stubGlobal(
    'WebSocket',
    class {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      send = send;
      close = close;
      constructor() {
        sockets.push(this);
        queueMicrotask(() => this.onopen?.());
      }
    },
  );
  const handlers = {
    onSpeechActivity: vi.fn(),
    onPartial: vi.fn(),
    onFinal: vi.fn(),
    onError: vi.fn(),
    onEnd: vi.fn(),
  };
  const session = await startStreamingAsr(handlers);
  expect(JSON.parse(send.mock.calls[0]![0])).toMatchObject({ split_silence_ms: 500 });
  const speech = { inputBuffer: { getChannelData: () => new Float32Array(1600).fill(0.1) } };
  processor.onaudioprocess?.(speech);
  expect(handlers.onSpeechActivity).not.toHaveBeenCalled();
  session!.resume();
  processor.onaudioprocess?.(speech);
  expect(handlers.onSpeechActivity).toHaveBeenCalledOnce();
  expect(send.mock.calls[1]![0]).toBeInstanceOf(ArrayBuffer);
  session!.pause();
  processor.onaudioprocess?.(speech);
  expect(handlers.onSpeechActivity).toHaveBeenCalledOnce();
  session!.finish();
  sockets[0]!.onclose?.();
  expect(handlers.onEnd).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(4000);
  expect(track.stop).toHaveBeenCalledOnce();
  expect(processor.disconnect).toHaveBeenCalledOnce();
  expect(closeContext).toHaveBeenCalledOnce();
  expect(close).toHaveBeenCalledOnce();
});
