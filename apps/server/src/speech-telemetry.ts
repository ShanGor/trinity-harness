import { metrics } from '@opentelemetry/api';

/**
 * Speech/phone telemetry (docs/voice-call-design.md §8.4). Instruments come
 * from the `@opentelemetry/api` GLOBAL meter: no-ops until `@trinity-harness/
 * otel` registers an SDK, so tests and inline mode stay free. Attribute
 * cardinality is bounded — never session/user/utterance ids (design §8.4);
 * only low-cardinality `kind`/`result` labels.
 */

const meter = metrics.getMeter('trinity-harness/server-speech');

/** Speech API requests by kind and outcome (batch asr/tts + stream opens). */
export const speechRequests = meter.createCounter('trinity.speech.requests', {
  description: 'Speech API requests by kind and result',
  unit: '{request}',
});

/** Audio submitted for recognition (batch uploads + streaming chunks). */
export const asrAudioBytes = meter.createHistogram('trinity.speech.asr_audio_bytes', {
  description: 'Audio bytes submitted for recognition per request',
  unit: 'By',
});

/** Streaming ASR provisional (partial) results relayed to clients. */
export const asrPartials = meter.createCounter('trinity.speech.asr_partials', {
  description: 'Streaming ASR partial results relayed',
  unit: '{message}',
});

/** Streaming ASR final segments relayed to clients. */
export const asrFinals = meter.createCounter('trinity.speech.asr_finals', {
  description: 'Streaming ASR final segments relayed',
  unit: '{message}',
});

/** TTS characters synthesized per request. */
export const ttsCharacters = meter.createHistogram('trinity.speech.tts_characters', {
  description: 'TTS characters synthesized per request',
  unit: '{character}',
});

/** Wall-clock duration of one TTS synthesis stream (open → close). */
export const ttsStreamSeconds = meter.createHistogram('trinity.speech.tts_stream_seconds', {
  description: 'TTS synthesis stream duration',
  unit: 's',
});

/** TTS synthesis streams currently open. */
export const ttsActiveStreams = meter.createUpDownCounter('trinity.speech.tts_active_streams', {
  description: 'Open TTS synthesis streams',
  unit: '{stream}',
});

/** Streaming ASR connections currently open. */
export const asrActiveStreams = meter.createUpDownCounter('trinity.speech.asr_active_streams', {
  description: 'Open streaming ASR connections',
  unit: '{connection}',
});

/** Quota denials by reason. */
export const speechQuotaDenied = meter.createCounter('trinity.speech.quota_denied', {
  description: 'Speech requests denied by quota, by reason',
  unit: '{request}',
});
