/**
 * WebRTC media client (docs/webrtc-media-design.md): carries the phone call's
 * microphone uplink over a real RTCPeerConnection through the server's
 * signaling relay to the werift gateway adapter, which feeds Fun-ASR.
 * Provisional/final results arrive as media.asr_* signaling messages and are
 * fenced exactly like the streaming-ASR path (voice-call-design.md §8.1/§8.2).
 *
 * Establishment failures resolve null so the controller falls back to the
 * delivered streaming-ASR path; a failure AFTER media.ready ends the call
 * with a reconnectable error (the controller owns that policy).
 *
 * Scope: uplink only — Assistant speech keeps using the SSE Qwen3-TTS path.
 */

const TOKEN_KEY = 'trinity.token';

export interface WebRtcAsrHandlers {
  /** Provisional recognition text; must never be treated as a prompt. */
  onPartial(text: string): void;
  /** VAD-endpointed final segment; safe to submit as an utterance. */
  onFinal(text: string): void;
  onError(message: string): void;
  /** The media session ended (signal/media error, quota, shutdown). */
  onEnd(reason: string): void;
}

export interface WebRtcDownlink {
  /** Resolves on media.tts_ended (natural end or stop); rejects on tts_unavailable. */
  speak(text: string, signal: AbortSignal): Promise<void>;
  stopSpeaking(): void;
}

export interface WebRtcAsrSession {
  /** Start/continue delivering microphone audio. */
  resume(): void;
  /** Stop delivering audio (turn-taking: Agent is speaking/thinking). */
  pause(): void;
  /** Close the peer connection, signaling socket and microphone. Idempotent. */
  finish(): void;
  readonly active: boolean;
  /**
   * TTS downlink over the same peer connection (docs/webrtc-media-design.md).
   * speak() resolves when the gateway signals tts_ended (natural end or
   * stop), rejects on tts_unavailable; `signal` aborts the downlink and
   * resolves. Absent when the session does not support downlink.
   */
  downlink?: WebRtcDownlink;
}

/** Injected for tests; defaults to the browser fetch. */
export interface WebRtcClientDeps {
  fetch?: typeof fetch;
  signalingUrl?: string;
}

export async function startWebRtcAsr(
  sessionId: string,
  handlers: WebRtcAsrHandlers,
  deps: WebRtcClientDeps = {},
): Promise<WebRtcAsrSession | null> {
  if (!window.isSecureContext || typeof RTCPeerConnection === 'undefined') return null;
  const fetchImpl = deps.fetch ?? fetch;

  // 1. Short-lived media token, bound to this Chat/Work session.
  let mediaToken: string;
  try {
    const response = await fetchImpl('/api/media/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ sessionId }),
    });
    if (!response.ok) return null; // 501: media plane not configured
    mediaToken = ((await response.json()) as { token: string }).token;
  } catch {
    return null;
  }

  // 2. Microphone + peer connection (created inside the click gesture chain).
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
  });
  const pc = new RTCPeerConnection();
  pc.addTrack(stream.getAudioTracks()[0]!);

  // Remote audio (TTS downlink) plays through a dedicated context created in
  // the call-start gesture chain; connect the track when it arrives.
  const playbackContext = new AudioContext();
  pc.ontrack = (event: RTCTrackEvent) => {
    const remote = event.streams[0] ?? new MediaStream([event.track]);
    try {
      const source = playbackContext.createMediaStreamSource(remote);
      source.connect(playbackContext.destination);
      void playbackContext.resume();
    } catch {
      // Track ended before wiring; nothing to play.
    }
  };

  // 3. Signaling socket (login token at upgrade, media token in hello).
  const loginToken = sessionStorage.getItem(TOKEN_KEY);
  const url = new URL(deps.signalingUrl ?? '/api/media/signaling', window.location.href);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  if (loginToken) url.searchParams.set('token', loginToken);
  const ws = new WebSocket(url);
  ws.onmessage = (event: MessageEvent<string>) => {
    let message: {
      type?: string;
      code?: string;
      message?: string;
      sdp?: string;
      candidate?: RTCIceCandidateInit;
      mediaSessionId?: string;
      text?: string;
    };
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    switch (message.type) {
      case 'media.ready':
        void startOffer();
        break;
      case 'media.answer':
        if (message.sdp) {
          void pc.setRemoteDescription({ type: 'answer', sdp: message.sdp }).catch(() => {
            handlers.onError('Failed to apply the media answer');
          });
        }
        break;
      case 'media.ice':
        if (message.candidate) {
          void pc.addIceCandidate(message.candidate).catch(() => {
            // A single candidate failure is not fatal.
          });
        }
        break;
      case 'media.asr_partial':
        if (message.text) handlers.onPartial(message.text);
        break;
      case 'media.asr_final':
        if (message.text) handlers.onFinal(message.text);
        break;
      case 'media.tts_ended': {
        const resolve = pendingSpeak?.resolve;
        pendingSpeak = null;
        resolve?.();
        break;
      }
      case 'media.error': {
        const pending = pendingSpeak;
        pendingSpeak = null;
        if (pending) {
          if (message.code === 'tts_unavailable') {
            pending.reject(new Error(message.message ?? 'TTS downlink unavailable'));
          } else {
            pending.resolve();
          }
        }
        teardown();
        handlers.onError(message.message ?? message.code ?? 'Media error');
        break;
      }
    }
  };

  const startOffer = async (): Promise<void> => {
    try {
      await pc.setLocalDescription(await pc.createOffer());
      if (ws.readyState === WebSocket.OPEN && pc.localDescription) {
        ws.send(JSON.stringify({ type: 'media.offer', sdp: pc.localDescription.sdp }));
      }
    } catch {
      handlers.onError('Failed to start the media session');
    }
  };

  pc.onicecandidate = (event: RTCPeerConnectionIceEvent) => {
    if (event.candidate && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'media.ice', candidate: event.candidate.toJSON() }));
    }
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      teardown();
      handlers.onEnd(`peer connection ${pc.connectionState}`);
    }
  };

  let active = true;
  /** One in-flight downlink speak(); resolved by tts_ended or abort. */
  let pendingSpeak: { resolve(): void; reject(error: Error): void } | null = null;

  const teardown = (): void => {
    if (!active) return;
    active = false;
    try {
      ws.close();
    } catch {
      // Already closed.
    }
    try {
      pc.close();
    } catch {
      // Already closed.
    }
    pendingSpeak?.resolve();
    pendingSpeak = null;
    stream.getTracks().forEach((track) => track.stop());
    void playbackContext.close().catch(() => {
      // Already closed.
    });
  };

  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(true);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
    ws.onclose = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
  if (!opened) {
    teardown();
    return null;
  }
  ws.send(JSON.stringify({ type: 'media.hello', token: mediaToken, sessionId }));

  return {
    get active() {
      return active;
    },
    resume() {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
    },
    pause() {
      stream.getAudioTracks().forEach((track) => {
        track.enabled = false;
      });
    },
    finish() {
      if (!active) return;
      try {
        ws.send(JSON.stringify({ type: 'media.bye' }));
      } catch {
        // Closing anyway.
      }
      teardown();
    },
    downlink: {
      speak(text: string, signal: AbortSignal): Promise<void> {
        return new Promise<void>((resolve, reject) => {
          if (!active || ws.readyState !== WebSocket.OPEN) {
            reject(new Error('Media session is closed'));
            return;
          }
          const onAbort = (): void => {
            if (ws.readyState === WebSocket.OPEN) {
              try {
                ws.send(JSON.stringify({ type: 'media.stop_speaking' }));
              } catch {
                // Closing anyway.
              }
            }
            entry.resolve();
          };
          const entry = {
            resolve: (): void => {
              if (pendingSpeak === entry) pendingSpeak = null;
              signal.removeEventListener('abort', onAbort);
              resolve();
            },
            reject: (error: Error): void => {
              if (pendingSpeak === entry) pendingSpeak = null;
              signal.removeEventListener('abort', onAbort);
              reject(error);
            },
          };
          pendingSpeak = entry;
          signal.addEventListener('abort', onAbort, { once: true });
          try {
            ws.send(JSON.stringify({ type: 'media.speak', text }));
          } catch (error) {
            entry.reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
      stopSpeaking() {
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'media.stop_speaking' }));
          } catch {
            // Closing anyway.
          }
        }
      },
    },
  };
}

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { authorization: `Bearer ${token}` } : {};
}
