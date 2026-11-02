// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';

import { startWebRtcAsr } from '../src/media-client.js';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('keeps WebRTC uplink silent through setup until pre-roll hands over capture', async () => {
  vi.stubGlobal('isSecureContext', true);
  const track = { enabled: true, stop: vi.fn() };
  const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn(async () => stream) },
  });
  const closeContext = vi.fn(async () => undefined);
  const onSpeechActivity = vi.fn();
  const processor = {
    connect: vi.fn(),
    disconnect: vi.fn(),
    onaudioprocess: null as
      ((event: { inputBuffer: { getChannelData(): Float32Array } }) => void) | null,
  };
  vi.stubGlobal(
    'AudioContext',
    class {
      close = closeContext;
      resume = vi.fn(async () => undefined);
      createMediaStreamSource = () => ({ connect: vi.fn(), disconnect: vi.fn() });
      createScriptProcessor = () => processor;
    },
  );
  const addTrack = vi.fn(() => expect(track.enabled).toBe(false));
  const closePeer = vi.fn();
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      addTrack = addTrack;
      connectionState = 'new';
      onconnectionstatechange: (() => void) | null = null;
      close = () => {
        closePeer();
        this.connectionState = 'closed';
        this.onconnectionstatechange?.();
      };
    },
  );
  const closeSocket = vi.fn();
  const sockets: { onclose: (() => void) | null }[] = [];
  const onEnd = vi.fn();
  vi.stubGlobal(
    'WebSocket',
    class {
      static OPEN = 1;
      readyState = 1;
      onopen: (() => void) | null = null;
      onclose: (() => void) | null = null;
      send = vi.fn();
      close = closeSocket;
      constructor() {
        sockets.push(this);
        queueMicrotask(() => this.onopen?.());
      }
    },
  );

  const session = await startWebRtcAsr(
    'session-a',
    {
      onPartial: vi.fn(),
      onFinal: vi.fn(),
      onError: vi.fn(),
      onEnd,
      onSpeechActivity,
    },
    {
      fetch: vi.fn(async () => new Response(JSON.stringify({ token: 'test-token' }))),
    },
  );

  expect(session).not.toBeNull();
  expect(addTrack).toHaveBeenCalledOnce();
  expect(track.enabled).toBe(false);
  const speech = { inputBuffer: { getChannelData: () => new Float32Array([0.1, -0.1]) } };
  processor.onaudioprocess?.(speech);
  expect(onSpeechActivity).not.toHaveBeenCalled();
  session!.resume();
  processor.onaudioprocess?.(speech);
  expect(onSpeechActivity).toHaveBeenCalledOnce();
  expect(track.enabled).toBe(true);
  session!.pause();
  processor.onaudioprocess?.(speech);
  expect(onSpeechActivity).toHaveBeenCalledOnce();
  expect(track.enabled).toBe(false);
  sockets[0]!.onclose?.();
  expect(onEnd).toHaveBeenCalledWith('signaling connection closed');
  expect(onEnd).toHaveBeenCalledOnce();
  session!.finish();
  expect(track.stop).toHaveBeenCalledOnce();
  expect(closePeer).toHaveBeenCalledOnce();
  expect(closeSocket).toHaveBeenCalledOnce();
  expect(closeContext).toHaveBeenCalledOnce();
  expect(processor.disconnect).toHaveBeenCalledOnce();
});
