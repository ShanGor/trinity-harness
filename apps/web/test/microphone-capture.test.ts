// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { connectMicrophoneCapture, hasSpeechActivity } from '../src/microphone-capture';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('distinguishes quiet frames from speech for both realtime transports', () => {
  expect(hasSpeechActivity(new Float32Array())).toBe(false);
  expect(hasSpeechActivity(new Float32Array([0.001, -0.001]))).toBe(false);
  expect(hasSpeechActivity(new Float32Array([0.1, -0.1]))).toBe(true);
});

it('delivers worklet activity and releases both ends of the silent capture graph', async () => {
  const source = { connect: vi.fn(), disconnect: vi.fn() };
  const node = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    port: { onmessage: null as ((event: { data: Float32Array }) => void) | null },
  };
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:capture', revokeObjectURL: revoke });
  vi.stubGlobal(
    'AudioWorkletNode',
    class {
      constructor() {
        return node;
      }
    },
  );
  const context = {
    createMediaStreamSource: () => source,
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    destination: {},
  };
  const onChunk = vi.fn();
  const release = await connectMicrophoneCapture(
    context as unknown as AudioContext,
    {} as MediaStream,
    onChunk,
  );
  const samples = new Float32Array([0.1]);
  node.port.onmessage?.({ data: samples });
  expect(onChunk).toHaveBeenCalledWith(samples);
  expect(revoke).toHaveBeenCalledWith('blob:capture');
  release();
  expect(source.disconnect).toHaveBeenCalledOnce();
  expect(node.disconnect).toHaveBeenCalledOnce();
});

it('releases the source and module URL if worklet setup fails', async () => {
  const source = { disconnect: vi.fn() };
  const revoke = vi.fn();
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:capture', revokeObjectURL: revoke });
  const context = {
    createMediaStreamSource: () => source,
    audioWorklet: {
      addModule: vi.fn(async () => {
        throw new Error('unavailable');
      }),
    },
  };
  await expect(
    connectMicrophoneCapture(context as unknown as AudioContext, {} as MediaStream, vi.fn()),
  ).rejects.toThrow('unavailable');
  expect(source.disconnect).toHaveBeenCalledOnce();
  expect(revoke).toHaveBeenCalledOnce();
});
