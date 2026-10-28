/**
 * Voice I/O client (docs/design.md §10): STT (mic recording → text) and TTS
 * (assistant text → streaming PCM audio) through the server's authenticated
 * /api/speech/* proxy routes. The browser never talks to the ASR/TTS
 * services directly.
 */

const TOKEN_KEY = 'trinity.token';

function authHeaders(): Record<string, string> {
  const token = sessionStorage.getItem(TOKEN_KEY);
  return token ? { authorization: `Bearer ${token}` } : {};
}

/** Transcribes a microphone recording via the Fun-ASR-backed proxy. */
export async function transcribeSpeechAudio(blob: Blob, signal?: AbortSignal): Promise<string> {
  // Parameters (e.g. ";codecs=opus") are stripped: the proxy validates a bare
  // audio/* MIME type, and Fun-ASR sniffs the container with ffmpeg anyway.
  const mime = (blob.type || 'audio/webm').split(';')[0]!.trim() || 'audio/webm';
  const response = await fetch(`/api/speech/transcriptions?mime=${encodeURIComponent(mime)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/octet-stream', ...authHeaders() },
    body: blob,
    signal,
  });
  if (!response.ok) {
    const hint = response.status === 502 ? ' — is the ASR service running?' : '';
    throw new Error(`Speech transcription failed (${response.status})${hint}`);
  }
  const body: unknown = await response.json();
  if (
    typeof body !== 'object' ||
    body === null ||
    typeof (body as { text?: unknown }).text !== 'string'
  ) {
    throw new Error('Speech transcription returned an invalid response');
  }
  return (body as { text: string }).text.trim();
}

export interface SpeechSynthesisStream {
  /** Mono PCM16 little-endian sample rate advertised by the TTS service. */
  sampleRate: number;
  /** Raw PCM16LE chunks decoded from the incremental SSE audio events. */
  stream: ReadableStream<Uint8Array>;
}

/**
 * Opens a token-streamed synthesis session. The wire format is SSE rather
 * than an octet-stream download because browser-facing proxies may buffer the
 * latter until the complete response arrives.
 */
export async function openSpeechSynthesisStream(
  text: string,
  signal: AbortSignal,
): Promise<SpeechSynthesisStream> {
  const response = await fetch('/api/speech/synthesis/stream', {
    method: 'POST',
    headers: {
      accept: 'text/event-stream',
      'content-type': 'application/json',
      ...authHeaders(),
    },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!response.ok || !response.body) {
    const hint = response.status === 502 ? ' — is the TTS service running?' : '';
    throw new Error(`Speech synthesis failed (${response.status})${hint}`);
  }
  if (!response.headers.get('content-type')?.includes('text/event-stream')) {
    throw new Error('Speech synthesis did not return a realtime event stream.');
  }
  const headerRate = Number(response.headers.get('x-sample-rate') ?? '24000');
  return {
    sampleRate: Number.isFinite(headerRate) && headerRate > 0 ? headerRate : 24_000,
    stream: speechSynthesisEventsToPcm(response.body),
  };
}

interface ParsedSpeechFrame {
  audio: Uint8Array | null;
  complete: boolean;
}

/** Converts the server's speech.* SSE events back into incremental PCM. */
export function speechSynthesisEventsToPcm(
  body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = decodeSpeechAudioEvents(body)[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const item = await iterator.next();
      if (item.done) controller.close();
      else controller.enqueue(item.value);
    },
    async cancel(reason) {
      await iterator.return(undefined);
      await body.cancel(reason);
    },
  });
}

async function* decodeSpeechAudioEvents(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<Uint8Array, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  let complete = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      for (;;) {
        const boundary = /\r?\n\r?\n/.exec(buffered);
        if (!boundary) break;
        const frame = buffered.slice(0, boundary.index);
        buffered = buffered.slice(boundary.index + boundary[0].length);
        const parsed = parseSpeechFrame(frame);
        if (parsed.audio) yield parsed.audio;
        if (parsed.complete) complete = true;
      }
    }
    buffered += decoder.decode();
    if (!complete) throw new Error('Speech synthesis ended before its completion event.');
  } finally {
    reader.releaseLock();
  }
}

function parseSpeechFrame(frame: string): ParsedSpeechFrame {
  let event = '';
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice('event:'.length).trim();
    else if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
  }
  const payload = data.join('\n');
  if (event === 'speech.complete') return { audio: null, complete: true };
  if (event === 'speech.error') {
    const parsed: unknown = payload ? JSON.parse(payload) : null;
    const detail =
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as { error?: unknown }).error === 'string'
        ? (parsed as { error: string }).error
        : 'Speech synthesis failed.';
    throw new Error(detail);
  }
  if (event !== 'speech.audio_chunk') return { audio: null, complete: false };

  const parsed: unknown = JSON.parse(payload);
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { audio?: unknown }).audio !== 'string'
  ) {
    throw new Error('Speech synthesis returned an invalid audio event.');
  }
  return {
    audio: decodeBase64((parsed as { audio: string }).audio),
    complete: false,
  };
}

function decodeBase64(encoded: string): Uint8Array {
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
