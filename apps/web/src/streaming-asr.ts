/**
 * Streaming ASR client (docs/voice-call-design.md §8.1): browser microphone →
 * PCM16 16 kHz frames → authenticated `/api/speech/asr/stream` WebSocket →
 * Fun-ASR `/ws` (via the server proxy). Provisional partials are captioned;
 * VAD-endpointed finals are delivered to the caller one utterance at a time.
 *
 * Capture follows the reference Fun-ASR frontend patterns: a 16 kHz
 * AudioContext created inside the click gesture (autoplay policy), AudioWorklet
 * via blob URL with a ScriptProcessor fallback, integrate-and-dump resampling
 * with phase carry, and 100 ms (3200-byte) binary frames. Pause/resume only
 * gates frame delivery — the upstream session (and its VAD state) persists for
 * the whole call, so resuming mid-utterance continues recognition.
 */

const TOKEN_KEY = 'trinity.token';
const TARGET_RATE = 16_000;
const FRAME_SAMPLES = 1600; // 100 ms at 16 kHz

export interface StreamingAsrHandlers {
  /** Provisional recognition text; must never be treated as a prompt. */
  onPartial(text: string): void;
  /** VAD-endpointed final segment; safe to submit as an utterance. */
  onFinal(text: string): void;
  onError(message: string): void;
  /** The server ended the session (protocol error / quota / shutdown). */
  onEnd(reason: string): void;
}

export interface StreamingAsrSession {
  /** Start/continue delivering microphone frames to the recognizer. */
  resume(): void;
  /** Stop delivering frames (turn-taking: Agent is speaking/thinking). */
  pause(): void;
  /** Flush the frame tail, signal end-of-input and close. Idempotent. */
  finish(): void;
  /** True between a successful start and finish/close. */
  readonly active: boolean;
}

/** Integrate-and-dump resampler carrying phase across callbacks. */
export function createPcmResampler(inputRate: number, outputRate = TARGET_RATE) {
  const ratio = inputRate / outputRate;
  let filled = 0;
  let sum = 0;
  return (input: Float32Array): number[] => {
    if (inputRate === outputRate) return Array.from(input);
    const output: number[] = [];
    for (const sample of input) {
      let remaining = 1;
      let s = sample;
      while (remaining > 0) {
        const take = Math.min(remaining, ratio - filled);
        sum += s * take;
        filled += take;
        remaining -= take;
        s = 0;
        if (filled >= ratio - 1e-9) {
          output.push(sum / ratio);
          filled = 0;
          sum = 0;
        }
      }
    }
    return output;
  };
}

/** float32 [-1,1] → int16 sample. */
export function floatToInt16(sample: number): number {
  const clamped = Math.max(-1, Math.min(1, sample));
  return clamped < 0 ? Math.round(clamped * 0x8000) : Math.round(clamped * 0x7fff);
}

interface AsrMessage {
  mode?: string;
  text?: string;
  is_final?: boolean;
  is_end?: boolean;
  append_to_previous?: boolean;
  error?: string;
}

/**
 * Opens a streaming session. Resolves null when the proxy answers 501 (no
 * speech config) or the upgrade is denied before opening; rejects on
 * microphone/capture failures. Quota denials arrive as a close during the
 * handshake → resolved null so the caller can fall back to batch ASR.
 */
export async function startStreamingAsr(
  handlers: StreamingAsrHandlers,
): Promise<StreamingAsrSession | null> {
  if (!window.isSecureContext || typeof WebSocket === 'undefined') return null;

  const token = sessionStorage.getItem(TOKEN_KEY);
  const wsUrl = new URL('/api/speech/asr/stream', window.location.href);
  wsUrl.protocol = wsUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  if (token) wsUrl.searchParams.set('token', token);

  const ws = new WebSocket(wsUrl);
  ws.binaryType = 'arraybuffer';

  const opened = await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    ws.onopen = () => {
      clearTimeout(timer);
      resolve(true);
    };
    // 1013 (quota/server busy) or an outright failure: fall back to batch.
    ws.onclose = () => {
      clearTimeout(timer);
      resolve(false);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      resolve(false);
    };
  });
  if (!opened) {
    try {
      ws.close();
    } catch {
      // Never opened; nothing to close.
    }
    return null;
  }

  // ---- microphone + capture pipeline -------------------------------
  const AudioContextClass =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) {
    ws.close();
    return null;
  }
  let context: AudioContext;
  try {
    context = new AudioContextClass({ sampleRate: TARGET_RATE });
  } catch {
    context = new AudioContextClass();
  }
  if (context.state === 'suspended') await context.resume();

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  } catch (error) {
    ws.close();
    void context.close();
    throw error;
  }

  let sending = false;
  let finished = false;
  let active = true;
  const pending: number[] = [];
  const resample = createPcmResampler(context.sampleRate);

  const sendConfig = (): void => {
    ws.send(
      JSON.stringify({
        mode: '2pass',
        itn: true,
        diarize: false, // single-speaker phone mode: skip speaker embeddings
        split_silence_ms: 700,
      }),
    );
  };

  const onChunk = (samples: Float32Array): void => {
    if (!sending || finished) return;
    const pcm = resample(samples);
    for (let i = 0; i < pcm.length; i += 1) pending.push(floatToInt16(pcm[i]!));
    while (pending.length >= FRAME_SAMPLES && ws.readyState === WebSocket.OPEN) {
      const frame = new Int16Array(FRAME_SAMPLES);
      for (let i = 0; i < FRAME_SAMPLES; i += 1) frame[i] = pending.shift()!;
      ws.send(frame.buffer);
    }
  };

  let captureNode: AudioNode | null = null;
  try {
    const source = context.createMediaStreamSource(stream);
    const workletCode = `
      class TrinityPcmCapture extends AudioWorkletProcessor {
        process(inputs) {
          const ch = inputs[0] && inputs[0][0];
          if (ch) this.port.postMessage(ch.slice(0));
          return true;
        }
      }
      registerProcessor('trinity-pcm-capture', TrinityPcmCapture);`;
    if (context.audioWorklet) {
      const moduleUrl = URL.createObjectURL(
        new Blob([workletCode], { type: 'application/javascript' }),
      );
      try {
        await context.audioWorklet.addModule(moduleUrl);
      } finally {
        URL.revokeObjectURL(moduleUrl);
      }
      const node = new AudioWorkletNode(context, 'trinity-pcm-capture');
      node.port.onmessage = (e: MessageEvent<Float32Array>) => onChunk(e.data);
      source.connect(node);
      node.connect(context.destination);
      captureNode = node;
    } else {
      const sp = context.createScriptProcessor(4096, 1, 1);
      sp.onaudioprocess = (e) => onChunk(new Float32Array(e.inputBuffer.getChannelData(0)));
      source.connect(sp);
      sp.connect(context.destination);
      captureNode = sp;
    }
  } catch {
    stream.getTracks().forEach((track) => track.stop());
    void context.close();
    ws.close();
    throw new Error('Audio capture is not supported by this browser');
  }

  // ---- wire format ---------------------------------------------------
  ws.onmessage = (event: MessageEvent<string>) => {
    let m: AsrMessage;
    try {
      m = JSON.parse(event.data) as AsrMessage;
    } catch {
      return;
    }
    if (m.error) {
      handlers.onError(m.error);
      return;
    }
    if (m.append_to_previous) return; // punctuation-only; see module doc
    if (m.is_final === true && m.is_end === true) {
      handlers.onEnd('recognizer ended the session');
      return;
    }
    const text = (m.text ?? '').trim();
    if (!text) return;
    if (m.is_final === false) handlers.onPartial(text);
    else if (m.is_final === true) handlers.onFinal(text);
  };
  ws.onclose = () => {
    active = false;
  };
  ws.onerror = () => {
    handlers.onError('Streaming speech connection error');
  };

  sendConfig();

  const release = (): void => {
    try {
      captureNode?.disconnect();
    } catch {
      // Already released.
    }
    stream.getTracks().forEach((track) => track.stop());
    void context.close();
  };

  return {
    get active() {
      return active;
    },
    resume() {
      sending = true;
    },
    pause() {
      sending = false;
    },
    finish() {
      if (finished) return;
      finished = true;
      sending = false;
      if (ws.readyState === WebSocket.OPEN) {
        // Send the sub-100 ms tail before the stop control message.
        if (pending.length > 0) {
          const tail = new Int16Array(pending.splice(0));
          ws.send(tail.buffer);
        }
        try {
          ws.send(JSON.stringify({ is_speaking: false, is_end: true }));
        } catch {
          // Socket already closing.
        }
      }
      release();
      // Give the flush a grace window, then drop the transport.
      setTimeout(() => {
        try {
          ws.close();
        } catch {
          // Already closed.
        }
      }, 4_000);
    },
  };
}
