import { randomUUID } from 'node:crypto';

import type {
  MediaGatewayEvent,
  MediaGatewayPort,
  MediaSession,
  MediaSessionRequest,
  MediaTtsFetch,
} from '@trinity-harness/contracts';
import { MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters } from 'werift';

import { FunAsrPipe } from './asr-pipe.js';
import { decodeUlawFrame, encodeUlawFrame, resampleTo8k, upsample8to16 } from './g711.js';

/**
 * werift-based media-gateway adapter (docs/webrtc-media-design.md): terminates
 * the browser's WebRTC audio uplink (G.711 μ-law over SRTP — PCMU is the only
 * advertised audio codec, so decoding is pure TypeScript with no Opus/native
 * dependency), converts to PCM16 mono 16 kHz, and streams it to Fun-ASR
 * `/ws`; provisional/final results are emitted as MediaGatewayEvents relayed
 * by the server's signaling socket.
 *
 * Scope of this first adapter: MIC UPLINK ONLY. Assistant speech keeps using
 * the delivered SSE Qwen3-TTS path; media downlink is a later increment.
 *
 * The peer connection runs ICE-LITE in the controlled role with host
 * candidates embedded in the answer SDP (non-trickle), which is sufficient
 * for LAN/same-host deployments; TURN is a deployment-time follow-up. werift
 * is a pure-TypeScript WebRTC stack — no native builds, no child processes —
 * chosen over mediasoup (native worker subprocess, conflicts with the repo's
 * process policy) and aiortc (second runtime, unavailable wheels). See the
 * design doc §2 for the selection record and maturity caveats.
 */

export interface WeriftGatewayOptions {
  /** Fun-ASR base URL (same target as the server's speech.asrUrl). */
  asrUrl: string;
  /** Advertised media-session lifetime (informational; enforcement is quota). */
  sessionTtlSeconds?: number;
  /**
   * Extra local addresses for ICE host candidates. Loopback is excluded by
   * default; pass ['127.0.0.1'] for same-host development and testing.
   */
  iceAdditionalHostAddresses?: string[];
  /** Injected for tests. */
  now?: () => Date;
  newId?: () => string;
}

interface DownlinkState {
  abort: AbortController;
  /** Encoded 20 ms μ-law frames waiting for their send tick. */
  queue: Buffer[];
  /** The upstream PCM stream is exhausted; send what remains then end. */
  tail: boolean;
  timer: ReturnType<typeof setInterval> | null;
  /** Emitted once when this downlink finished (natural end or stop). */
  endedEmitted: boolean;
}

interface GatewaySession {
  mediaSessionId: string;
  request: MediaSessionRequest;
  pc: RTCPeerConnection | null;
  asr: FunAsrPipe;
  pending16k: number[];
  closed: boolean;
  /** Local track registered with the audio sender — the TTS downlink target. */
  sendTrack: MediaStreamTrack | null;
  /** Negotiated PCMU payload type for the send direction. */
  sendPayloadType: number;
  sendSequence: number;
  sendTimestamp: number;
  downlink: DownlinkState | null;
}

const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz

export class WeriftMediaGateway implements MediaGatewayPort {
  private readonly sessions = new Map<string, GatewaySession>();
  private readonly listeners = new Set<(event: MediaGatewayEvent) => void>();
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: WeriftGatewayOptions) {
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /**
   * Allocate a session: opens the Fun-ASR upstream pipe immediately (fail
   * closed — no media session without a working recognizer) and waits for
   * the browser offer via answerOffer.
   */
  async allocate(request: MediaSessionRequest): Promise<MediaSession | null> {
    const mediaSessionId = this.newId();
    const asr = new FunAsrPipe(this.options.asrUrl, {
      onPartial: (text) => this.emit({ type: 'asr_partial', mediaSessionId, text }),
      onFinal: (text) => this.emit({ type: 'asr_final', mediaSessionId, text }),
      onError: (message) => this.emit({ type: 'ended', mediaSessionId, reason: message }),
      onClose: () => this.emit({ type: 'ended', mediaSessionId, reason: 'recognizer closed' }),
    });
    const started = await asr.start();
    if (!started) return null;
    this.sessions.set(mediaSessionId, {
      mediaSessionId,
      request,
      pc: null,
      asr,
      pending16k: [],
      closed: false,
      sendTrack: null,
      sendPayloadType: 0,
      sendSequence: Math.floor(Math.random() * 65_536),
      sendTimestamp: Math.floor(Math.random() * 2 ** 32),
      downlink: null,
    });
    const ttl = this.options.sessionTtlSeconds ?? 3_600;
    return {
      mediaSessionId,
      expiresAt: new Date(this.now().getTime() + ttl * 1000).toISOString(),
    };
  }

  /** Apply the browser offer (ICE-LITE answer with embedded host candidates). */
  async answerOffer(mediaSessionId: string, sdp: string): Promise<{ sdp: string } | null> {
    const session = this.sessions.get(mediaSessionId);
    if (!session || session.closed) return null;
    if (session.pc) return null; // One peer connection per media session.
    // Minimal fail-closed validation: werift tolerates unparseable SDP and
    // would answer with zero media sections instead of rejecting.
    if (!sdp.includes('m=') || !sdp.includes('v=0')) return null;
    const pc = new RTCPeerConnection({
      iceLite: true,
      iceUseIpv4: true,
      iceUseTcp: false,
      iceAdditionalHostAddresses: this.options.iceAdditionalHostAddresses ?? [],
      codecs: {
        // PCMU only: pure-JS μ-law decode (see module doc). Browsers treat
        // G.711 as mandatory (RFC 3551), so negotiation always succeeds.
        audio: [new RTCRtpCodecParameters({ mimeType: 'audio/PCMU', clockRate: 8000 })],
      },
    });
    pc.onTrack.subscribe((track) => {
      if (track.kind !== 'audio') return;
      track.onReceiveRtp.subscribe((packet) => this.handleRtp(session, packet.payload));
    });
    pc.connectionStateChange.subscribe((state) => {
      if (state === 'failed' || state === 'closed') {
        this.emit({ type: 'ended', mediaSessionId, reason: `peer connection ${state}` });
      }
    });
    await pc.setRemoteDescription({ type: 'offer', sdp });
    // The browser offers sendrecv; without a local direction override werift
    // answers recvonly and the TTS downlink track would never send. Register
    // a local track on the audio sender — remote tracks reject writeRtp.
    const localSendTrack = new MediaStreamTrack({ kind: 'audio' });
    for (const transceiver of pc.getTransceivers()) {
      if (transceiver.kind === 'audio' || transceiver.receiver.track.kind === 'audio') {
        transceiver.direction = 'sendrecv';
        await transceiver.sender.replaceTrack(localSendTrack);
        session.sendTrack = localSendTrack;
      }
    }
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    // ICE-LITE gathers host candidates only; wait briefly so the answer SDP
    // carries them (non-trickle — browsers on the same LAN can connect
    // without further signaling round-trips).
    if (pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3_000);
        pc.iceGatheringStateChange.subscribe((state) => {
          if (state === 'complete') {
            clearTimeout(timer);
            resolve();
          }
        });
      });
    }
    session.pc = pc;
    const local = pc.localDescription;
    if (!local) return null;
    const ptMatch = /a=rtpmap:(\d+) PCMU\//i.exec(local.sdp);
    session.sendPayloadType = ptMatch ? Number(ptMatch[1]) : 0;
    return { sdp: local.sdp };
  }

  async addIceCandidate(
    mediaSessionId: string,
    candidate: Record<string, unknown>,
  ): Promise<boolean> {
    const session = this.sessions.get(mediaSessionId);
    if (!session?.pc || session.closed) return false;
    try {
      await session.pc.addIceCandidate(
        candidate as Parameters<RTCPeerConnection['addIceCandidate']>[0],
      );
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Start a TTS downlink: fetch PCM through the quota-enforcing fetcher,
   * transcode to μ-law 8 kHz and pace 20 ms frames over the peer connection.
   * The downlink signals completion with a `tts_ended` event (natural end or
   * stop). False ⇒ it could not start; no event follows.
   */
  async speak(mediaSessionId: string, text: string, fetchPcm: MediaTtsFetch): Promise<boolean> {
    const session = this.sessions.get(mediaSessionId);
    if (!session || session.closed || !session.sendTrack || !session.pc) return false;
    this.resetDownlink(session, false);
    const abort = new AbortController();
    const stream = await fetchPcm(text, abort.signal);
    if (!stream || session.closed || abort.signal.aborted) return false;
    session.downlink = {
      abort,
      queue: [],
      tail: false,
      timer: null,
      endedEmitted: false,
    };
    void this.consumeDownlink(session, stream.sampleRate, stream.chunks);
    session.downlink.timer = setInterval(() => this.pumpDownlinkFrame(session), 20);
    return true;
  }

  /** Stop the current downlink immediately and emit its `tts_ended`. */
  async stopSpeaking(mediaSessionId: string): Promise<void> {
    const session = this.sessions.get(mediaSessionId);
    if (!session) return;
    this.resetDownlink(session, true);
  }

  async close(mediaSessionId: string): Promise<void> {
    const session = this.sessions.get(mediaSessionId);
    if (!session) return;
    session.closed = true;
    this.resetDownlink(session, false);
    try {
      session.pc?.close();
    } catch {
      // Already closed.
    }
    session.asr.stop();
    this.sessions.delete(mediaSessionId);
  }

  onEvent(listener: (event: MediaGatewayEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private handleRtp(session: GatewaySession, payload: Buffer): void {
    if (session.closed) return;
    const pcm8k = decodeUlawFrame(payload);
    const pcm16k = upsample8to16(pcm8k);
    for (let i = 0; i < pcm16k.length; i += 1) session.pending16k.push(pcm16k[i]!);
    while (session.pending16k.length >= FRAME_SAMPLES) {
      const frame = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i += 1) frame[i] = session.pending16k.shift()!;
      session.asr.writePcm16(frame);
    }
  }

  /** Pull PCM chunks from the TTS fetcher, transcode and queue 20 ms frames. */
  private async consumeDownlink(
    session: GatewaySession,
    sampleRate: number,
    chunks: AsyncIterable<Int16Array>,
  ): Promise<void> {
    try {
      for await (const pcm of chunks) {
        const downlink = session.downlink;
        if (!downlink || downlink.abort.signal.aborted || session.closed) return;
        const pcm8k = resampleTo8k(pcm, sampleRate);
        const encoded = encodeUlawFrame(pcm8k);
        for (let off = 0; off + 160 <= encoded.length; off += 160) {
          downlink.queue.push(Buffer.from(encoded.subarray(off, off + 160)));
        }
      }
      if (session.downlink) session.downlink.tail = true;
    } catch {
      // Fetcher failure: end the downlink so the waiting speak() resolves.
      if (session.downlink) session.downlink.tail = true;
    }
  }

  /** Send one 20 ms μ-law frame; at the tail, emit `tts_ended` once. */
  private pumpDownlinkFrame(session: GatewaySession): void {
    const downlink = session.downlink;
    if (!downlink) return;
    const frame = downlink.queue.shift();
    if (frame && session.sendTrack) {
      const header = Buffer.alloc(12);
      header[0] = 0x80;
      header[1] = session.sendPayloadType & 0x7f;
      header.writeUInt16BE(session.sendSequence & 0xffff, 2);
      header.writeUInt32BE(session.sendTimestamp >>> 0, 4);
      header.writeUInt32BE(0x5453_0001, 8); // fixed SSRC for the downlink
      try {
        session.sendTrack.writeRtp(Buffer.concat([header, frame]));
      } catch {
        this.resetDownlink(session, true);
        return;
      }
      session.sendSequence = (session.sendSequence + 1) % 65_536;
      session.sendTimestamp = (session.sendTimestamp + 160) % 2 ** 32;
      return;
    }
    if (downlink.tail) {
      this.resetDownlink(session, true);
    }
  }

  /**
   * Tear down the downlink state. With `emitEnded` the `tts_ended` event
   * fires immediately — by then the queue has already drained, so the RTP
   * sequence is contiguous and the tail is in flight.
   */
  private resetDownlink(session: GatewaySession, emitEnded: boolean): void {
    const downlink = session.downlink;
    if (!downlink) return;
    session.downlink = null;
    downlink.abort.abort();
    if (downlink.timer) clearInterval(downlink.timer);
    if (emitEnded && !downlink.endedEmitted) {
      downlink.endedEmitted = true;
      this.emit({ type: 'tts_ended', mediaSessionId: session.mediaSessionId });
    }
  }

  private emit(event: MediaGatewayEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
