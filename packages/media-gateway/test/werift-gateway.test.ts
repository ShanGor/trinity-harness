import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { MediaStreamTrack, RTCPeerConnection } from 'werift';
import { WebSocketServer, type WebSocket as UpstreamSocket } from 'ws';

import type { MediaTtsFetch } from '@trinity-harness/contracts';

import { WeriftMediaGateway } from '../src/werift-gateway.js';
import { decodeUlawFrame, encodeUlawFrame } from '../src/g711.js';

/**
 * Loopback WebRTC integration test: a real werift peer (acting as the
 * browser) negotiates DTLS/SRTP with the gateway, sends G.711 audio, and the
 * gateway must deliver matching PCM16 16 kHz frames to the (fake) Fun-ASR
 * upstream. This exercises the full adapter without a browser.
 */

/** Fake Fun-ASR /ws upstream: captures binary PCM frames, speaks JSON. */
class FakeFunAsr {
  server: HttpServer;
  wss: WebSocketServer;
  receivedFrames: Buffer[] = [];
  receivedConfigs: string[] = [];
  socket: UpstreamSocket | null = null;

  private constructor(wss: WebSocketServer, server: HttpServer) {
    this.wss = wss;
    this.server = server;
  }

  static async start(): Promise<FakeFunAsr> {
    const http = createServer();
    const wss = new WebSocketServer({ server: http });
    const fake = new FakeFunAsr(wss, http);
    wss.on('connection', (socket) => {
      fake.socket = socket;
      socket.binaryType = 'nodebuffer';
      socket.on('message', (data, isBinary) => {
        if (isBinary) fake.receivedFrames.push(data as Buffer);
        else fake.receivedConfigs.push(String(data));
      });
    });
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    return fake;
  }

  url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }
}

async function waitForConnection(pc: RTCPeerConnection, timeoutMs = 20_000): Promise<void> {
  if (pc.connectionState === 'connected') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('peer connection timeout')), timeoutMs);
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'connected') {
        clearTimeout(timer);
        resolve();
      }
      if (state === 'failed' || state === 'closed') {
        clearTimeout(timer);
        reject(new Error(`peer connection ${state}`));
      }
    });
  });
}

/** Extract the negotiated PCMU payload type (expected 0) from an SDP answer. */
function pcmuPayloadType(sdp: string): number {
  const match = /a=rtpmap:(\d+) PCMU\//i.exec(sdp);
  if (!match) throw new Error('no PCMU codec in answer');
  return Number(match[1]);
}

describe('WeriftMediaGateway loopback (docs/webrtc-media-design.md §2)', () => {
  let fakeAsr: FakeFunAsr;
  let gateway: WeriftMediaGateway;

  beforeAll(async () => {
    fakeAsr = await FakeFunAsr.start();
    gateway = new WeriftMediaGateway({
      asrUrl: fakeAsr.url(),
      iceAdditionalHostAddresses: ['127.0.0.1'],
    });
  });

  afterAll(async () => {
    await fakeAsr.stop();
  });

  it('streams browser PCMU uplink as PCM16 16 kHz frames to Fun-ASR', async () => {
    const events: { type: string; text?: string }[] = [];
    gateway.onEvent((event) =>
      events.push(
        event.type === 'ended' || event.type === 'tts_ended'
          ? { type: event.type }
          : { type: event.type, text: event.text },
      ),
    );

    const session = await gateway.allocate({
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-1',
    });
    expect(session).not.toBeNull();
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(fakeAsr.receivedConfigs).toHaveLength(1);

    // ---- browser side (werift peer) ----
    const browser = new RTCPeerConnection({ iceUseTcp: false, iceUseIpv4: true });
    const track = new MediaStreamTrack({ kind: 'audio' });
    browser.addTrack(track);
    await browser.setLocalDescription(await browser.createOffer());
    if (browser.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        browser.iceGatheringStateChange.subscribe((state) => {
          if (state === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    }

    const answer = await gateway.answerOffer(
      session!.mediaSessionId,
      browser.localDescription!.sdp,
    );
    expect(answer).not.toBeNull();
    await browser.setRemoteDescription({ type: 'answer', sdp: answer!.sdp });
    await waitForConnection(browser);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // ---- send 1 s of constant-amplitude audio as 20 ms μ-law frames ----
    const pt = pcmuPayloadType(answer!.sdp);
    expect(pt).toBe(0);
    let sequenceNumber = Math.floor(Math.random() * 65_000);
    let timestamp = Math.floor(Math.random() * 2 ** 31);
    const ssrc = 123_456;
    const amplitude = 8_000;
    for (let frame = 0; frame < 50; frame += 1) {
      const pcm = new Int16Array(160).fill(amplitude); // 20 ms at 8 kHz
      const payload = Buffer.from(encodeUlawFrame(pcm));
      track.writeRtp(Buffer.concat([rtpHeader(pt, sequenceNumber, timestamp, ssrc), payload]));
      sequenceNumber = (sequenceNumber + 1) % 65_536;
      timestamp = (timestamp + 160) % 2 ** 32;
      await new Promise<void>((resolve) => setTimeout(resolve, 5)); // ≈ realtime-ish
    }

    // ---- assertions ----
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(fakeAsr.receivedFrames.length).toBeGreaterThan(5);
    const totalSamples = fakeAsr.receivedFrames.reduce((n, f) => n + f.length / 2, 0);
    expect(totalSamples).toBeGreaterThan(14_000); // ≈1 s ± pipeline tail
    for (const frame of fakeAsr.receivedFrames) {
      expect(frame.length % 2).toBe(0);
      // Constant-amplitude signal: μ-law roundtrip keeps magnitude high.
      for (let off = 0; off < frame.length; off += 2) {
        expect(Math.abs(frame.readInt16LE(off))).toBeGreaterThan(6_000);
      }
    }

    // Gateway relays ASR results emitted by the upstream.
    fakeAsr.socket!.send(JSON.stringify({ is_final: false, text: 'partial' }));
    fakeAsr.socket!.send(JSON.stringify({ is_final: true, is_end: false, text: 'final' }));
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(events).toContainEqual({ type: 'asr_partial', text: 'partial' });
    expect(events).toContainEqual({ type: 'asr_final', text: 'final' });

    await gateway.close(session!.mediaSessionId);
    browser.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(fakeAsr.wss.clients.size).toBe(0);
  }, 60_000);

  it('streams TTS downlink: PCM → μ-law RTP reaches the browser, then tts_ended', async () => {
    const events: { type: string }[] = [];
    gateway.onEvent((event) => events.push({ type: event.type }));

    const session = await gateway.allocate({
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-dl',
    });
    expect(session).not.toBeNull();

    // ---- browser side ----
    const browser = new RTCPeerConnection({ iceUseTcp: false, iceUseIpv4: true });
    const track = new MediaStreamTrack({ kind: 'audio' });
    browser.addTrack(track);
    // Collect frames the BROWSER receives on its (sendrecv) audio track.
    const receivedPayloads: Buffer[] = [];
    browser.onTrack.subscribe((remoteTrack) => {
      if (remoteTrack.kind !== 'audio') return;
      remoteTrack.onReceiveRtp.subscribe((packet) => receivedPayloads.push(packet.payload));
    });
    await browser.setLocalDescription(await browser.createOffer());
    if (browser.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        browser.iceGatheringStateChange.subscribe((state) => {
          if (state === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    }
    const answer = await gateway.answerOffer(
      session!.mediaSessionId,
      browser.localDescription!.sdp,
    );
    expect(answer).not.toBeNull();
    await browser.setRemoteDescription({ type: 'answer', sdp: answer!.sdp });
    await waitForConnection(browser);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));

    // ---- fake TTS source: 0.5 s of constant PCM at Qwen3-TTS's 24 kHz ----
    const fetchPcm: MediaTtsFetch = async () => {
      async function* chunks(): AsyncIterable<Int16Array> {
        for (let i = 0; i < 5; i += 1) {
          yield new Int16Array(2400).fill(8000); // 100 ms at 24 kHz
        }
      }
      return { sampleRate: 24_000, chunks: chunks() };
    };

    const ok = await gateway.speak(session!.mediaSessionId, 'test sentence', fetchPcm);
    expect(ok).toBe(true);

    // Natural completion: 0.5 s of audio at 20 ms/frame paced + tail event.
    await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
    expect(events).toContainEqual({ type: 'tts_ended' });
    expect(receivedPayloads.length).toBeGreaterThan(15); // ≈25 frames ± jitter
    for (const payload of receivedPayloads) {
      expect(payload.length).toBe(160); // 20 ms μ-law
      const pcm = decodeUlawFrame(payload);
      for (let i = 0; i < pcm.length; i += 1) {
        expect(Math.abs(pcm[i]!)).toBeGreaterThan(6_000);
      }
    }

    // A second speak works after the first ended (state machine reset).
    const again = await gateway.speak(session!.mediaSessionId, 'again', fetchPcm);
    expect(again).toBe(true);
    await gateway.stopSpeaking(session!.mediaSessionId);
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    expect(events.filter((e) => e.type === 'tts_ended')).toHaveLength(2);

    await gateway.close(session!.mediaSessionId);
    browser.close();
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
  }, 60_000);

  it('rejects speak without a peer connection and failed fetchPcm', async () => {
    const session = await gateway.allocate({
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-dl2',
    });
    const failing = async (): Promise<null> => null;
    // No peer connection yet → false, no event.
    expect(await gateway.speak(session!.mediaSessionId, 'x', failing)).toBe(false);
    await gateway.close(session!.mediaSessionId);
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }, 20_000);

  it('fails allocation when the Fun-ASR upstream is unavailable', async () => {
    const dead = new WeriftMediaGateway({
      asrUrl: 'http://127.0.0.1:1', // nothing listens here
      iceAdditionalHostAddresses: ['127.0.0.1'],
    });
    const session = await dead.allocate({
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-2',
    });
    expect(session).toBeNull();
  }, 20_000);

  it('rejects offers without media sections and on closed sessions', async () => {
    const session = await gateway.allocate({
      tenantId: 'tenant-1',
      userId: 'user-1',
      sessionId: 'session-3',
    });
    expect(session).not.toBeNull();
    expect(await gateway.answerOffer(session!.mediaSessionId, 'garbage')).toBeNull();
    await gateway.close(session!.mediaSessionId);
    expect(
      await gateway.answerOffer(
        session!.mediaSessionId,
        'v=0\r\nm=audio 9 UDP/TLS/RTP/SAVPF 0\r\n',
      ),
    ).toBeNull();
  }, 20_000);
});

/** Minimal 12-byte RTP header for the browser-side test track. */
function rtpHeader(payloadType: number, seq: number, ts: number, ssrc: number): Buffer {
  const header = Buffer.alloc(12);
  header[0] = 0x80; // V=2
  header[1] = payloadType & 0x7f;
  header.writeUInt16BE(seq & 0xffff, 2);
  header.writeUInt32BE(ts >>> 0, 4);
  header.writeUInt32BE(ssrc >>> 0, 8);
  return header;
}
